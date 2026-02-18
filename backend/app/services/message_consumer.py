"""
Real-time message consumer.

Subscribes to Redis `telegram:new_messages` channel and for each message:
1. Upserts contact in DB
2. Saves message to DB (dedup by telegram_msg_id)
3. Updates contact stats (total_messages, last_message_at, unresponded_count)
4. Periodically chunks + embeds recent messages for the contact

Respects the global pause flag `user:paused:{user_id}` — when set:
- Messages are STILL saved to DB (prevents data loss from pub/sub)
- Heavy processing is SKIPPED: rechunking, embedding, auto-suggestions
- On resume, `run_catchup_processing()` handles the accumulated backlog
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta

import redis.asyncio as aioredis
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import async_session
from app.models.contact import Contact
from app.models.message import Message
from app.models.chunk import ConversationChunk
from app.models.suggestion import ResponseSuggestion
from app.services.embedding import embed_texts
from app.services.ingestion import create_conversation_chunks

logger = logging.getLogger(__name__)
settings = get_settings()

# How many messages to accumulate before re-chunking/embedding a contact
RECHUNK_THRESHOLD = 5
# Track pending re-chunk counts per contact_id
_pending_rechunk: dict[uuid.UUID, int] = {}
# Lock to prevent concurrent re-chunk for the same contact
_rechunk_locks: dict[uuid.UUID, asyncio.Lock] = {}


async def _is_user_paused(redis_client: aioredis.Redis, user_id: uuid.UUID) -> bool:
    """Check if a user has global processing paused."""
    return await redis_client.exists(f"user:paused:{str(user_id)}") > 0


async def _get_or_create_contact(
    db: AsyncSession,
    user_id: uuid.UUID,
    chat_id: str,
    chat_name: str,
    chat_type: str = "personal_chat",
) -> Contact:
    """Find or create a contact for a live message."""
    stmt = select(Contact).where(
        Contact.user_id == user_id,
        Contact.telegram_id == chat_id,
    )
    result = await db.execute(stmt)
    contact = result.scalar_one_or_none()

    if contact:
        # Update display name if it changed on Telegram
        if chat_name and contact.display_name != chat_name:
            contact.display_name = chat_name
        return contact

    contact = Contact(
        user_id=user_id,
        telegram_id=chat_id,
        display_name=chat_name or f"Chat {chat_id}",
        chat_type=chat_type,
    )
    db.add(contact)
    await db.flush()
    logger.info(f"[CONSUMER] Created contact: {chat_name} ({chat_id})")
    return contact


async def _save_message(
    db: AsyncSession,
    contact: Contact,
    msg_data: dict,
) -> Message | None:
    """Save a message to DB. Returns None if duplicate."""
    telegram_msg_id = msg_data.get("telegram_msg_id")

    # Dedup check
    if telegram_msg_id:
        stmt = select(Message.id).where(
            Message.contact_id == contact.id,
            Message.telegram_msg_id == telegram_msg_id,
        )
        existing = await db.execute(stmt)
        if existing.scalar_one_or_none():
            return None

    is_incoming = msg_data.get("is_incoming", True)

    # Parse date — strip timezone info since DB uses naive timestamps
    if msg_data.get("date"):
        sent_at = datetime.fromisoformat(msg_data["date"])
        if sent_at.tzinfo is not None:
            sent_at = sent_at.replace(tzinfo=None)
    else:
        sent_at = datetime.utcnow()

    message = Message(
        user_id=contact.user_id,
        contact_id=contact.id,
        telegram_msg_id=telegram_msg_id,
        sender_type="other" if is_incoming else "self",
        sender_name=msg_data.get("sender_name", "Unknown"),
        content=msg_data.get("text", ""),
        sent_at=sent_at,
        is_read=not is_incoming,  # outgoing = read, incoming = unread
        is_responded=not is_incoming,  # outgoing = responded, incoming = not responded
    )
    db.add(message)

    # Update contact stats.
    # Keep recency monotonic: message streams can arrive out-of-order
    # during sync/reconnect, and we never want last_message_at to move backwards.
    previous_last = contact.last_message_at
    is_newest_message = previous_last is None or message.sent_at >= previous_last

    contact.total_messages = (contact.total_messages or 0) + 1
    if is_newest_message:
        contact.last_message_at = message.sent_at

    if is_incoming:
        contact.unresponded_count = (contact.unresponded_count or 0) + 1
    elif is_newest_message:
        # Only clear unread counter when this outgoing message is the latest one.
        # Older out-of-order self messages should not clear newer unread items.
        contact.unresponded_count = 0

    await db.flush()
    return message


async def _rechunk_and_embed_contact(
    user_id: uuid.UUID,
    contact_id: uuid.UUID,
    redis_client: aioredis.Redis | None = None,
):
    """Re-chunk and embed all messages for a contact.

    Checks global pause state at entry AND before the expensive embedding step.
    If paused, bails out — catch-up will handle it on resume.
    """
    lock = _rechunk_locks.setdefault(contact_id, asyncio.Lock())

    async with lock:
        # ── Pause guard (entry) ──
        if redis_client and await _is_user_paused(redis_client, user_id):
            logger.info(
                f"[CONSUMER] PAUSED — skipping rechunk for contact {contact_id} "
                f"(will catch up on resume)"
            )
            return

        async with async_session() as db:
            try:
                contact = await db.get(Contact, contact_id)
                if not contact:
                    return
                if contact.user_id != user_id:
                    logger.error(
                        f"[CONSUMER] Ownership mismatch: contact {contact_id} "
                        f"belongs to {contact.user_id}, not {user_id}"
                    )
                    return
                from app.models.user import User
                from app.api.deps import get_user_settings

                user = await db.get(User, user_id)
                if not user:
                    logger.warning(
                        f"[CONSUMER] User not found while re-chunking contact {contact_id}"
                    )
                    return
                user_settings = get_user_settings(user)

                logger.info(
                    f"[CONSUMER] Re-chunking contact {contact.display_name} "
                    f"({contact.total_messages} messages)"
                )

                # Delete old chunks
                await db.execute(
                    delete(ConversationChunk).where(
                        ConversationChunk.contact_id == contact_id
                    )
                )

                # Fetch all messages ordered by time
                stmt = (
                    select(Message)
                    .where(Message.contact_id == contact_id)
                    .order_by(Message.sent_at)
                )
                result = await db.execute(stmt)
                messages = result.scalars().all()

                if not messages:
                    await db.commit()
                    return

                # Create chunks
                chunks = create_conversation_chunks(messages)
                db_chunks = []
                for chunk in chunks:
                    db_chunk = ConversationChunk(
                        user_id=user_id,
                        contact_id=contact_id,
                        chunk_text=chunk.text,
                        session_start=chunk.start,
                        session_end=chunk.end,
                        message_count=chunk.count,
                    )
                    db.add(db_chunk)
                    db_chunks.append(db_chunk)

                await db.flush()

                # ── Pause guard (before embedding — the expensive API call) ──
                if redis_client and await _is_user_paused(redis_client, user_id):
                    logger.info(
                        f"[CONSUMER] PAUSED mid-rechunk — chunks created but "
                        f"embedding skipped for {contact.display_name} "
                        f"(will re-process on resume)"
                    )
                    await db.rollback()
                    return

                # Embed all chunks
                texts = [c.chunk_text for c in db_chunks]
                if texts:
                    logger.info(
                        f"[CONSUMER] Embedding {len(texts)} chunks for "
                        f"{contact.display_name}..."
                    )
                    embeddings = await embed_texts(
                        texts,
                        input_type="document",
                        user_id=user_id,
                        operation="live_message_embed",
                        user_settings=user_settings,
                    )
                    for db_chunk, emb in zip(db_chunks, embeddings):
                        db_chunk.embedding = emb

                await db.commit()
                logger.info(
                    f"[CONSUMER] Re-chunked {contact.display_name}: "
                    f"{len(db_chunks)} chunks, {len(texts)} embedded"
                )

                # Reset pending counter
                _pending_rechunk.pop(contact_id, None)

            except Exception as e:
                logger.error(
                    f"[CONSUMER] Re-chunk failed for contact {contact_id}: {e}",
                    exc_info=True,
                )
                await db.rollback()


async def _auto_generate_suggestion(
    user_id: uuid.UUID,
    contact_id: uuid.UUID,
    contact_name: str,
    auto_draft: bool = True,
    redis_client: aioredis.Redis | None = None,
):
    """Auto-generate a response suggestion for a new incoming message.

    Guards:
    - Skips if user is globally paused
    - Skips if there's already a pending suggestion for this contact
    - Wraps in try/except so failures never crash the consumer
    """
    try:
        # Pause guard — this task may have been queued before pause was set
        if redis_client and await _is_user_paused(redis_client, user_id):
            logger.info(
                f"[CONSUMER] PAUSED — skipping auto-suggestion for {contact_name}"
            )
            return
        async with async_session() as db:
            # Check for existing pending suggestion
            stmt = select(ResponseSuggestion.id).where(
                ResponseSuggestion.contact_id == contact_id,
                ResponseSuggestion.status == "pending",
            )
            existing = await db.execute(stmt)
            if existing.scalar_one_or_none():
                logger.info(
                    f"[CONSUMER] Skipping auto-suggest for {contact_name} — pending suggestion exists"
                )
                return

            # Look up user name for the prompt
            from app.models.user import User

            user = await db.get(User, user_id)
            if not user:
                return

            logger.info(f"[CONSUMER] Auto-generating suggestion for {contact_name}...")

            from app.services.response_generator import generate_reply
            from app.api.deps import get_user_settings

            suggestion = await generate_reply(
                db=db,
                user_id=user_id,
                contact_id=contact_id,
                user_name=user.name,
                user_settings=get_user_settings(user),
            )

            logger.info(
                f"[CONSUMER] Auto-suggestion {suggestion.id} created for {contact_name}"
            )

            # Look up contact's telegram_id so we can save draft
            contact = await db.get(Contact, contact_id)

            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            try:
                # Auto-save as Telegram draft only if auto_draft is enabled
                if auto_draft and contact:
                    await redis_client.publish(
                        f"telegram:send_commands:{str(user_id)}",
                        json.dumps(
                            {
                                "user_id": str(user_id),
                                "chat_id": contact.telegram_id,
                                "text": suggestion.suggested_response,
                                "mode": "draft",
                            }
                        ),
                    )
                    suggestion.status = "drafted"
                    await db.commit()
                    logger.info(
                        f"[CONSUMER] Auto-drafted suggestion for {contact_name}"
                    )

                # Notify frontend
                status_msg = f"Draft saved for {contact_name}" if auto_draft else f"Suggestion ready for {contact_name}"
                await redis_client.publish(
                    f"user:{str(user_id)}:events",
                    json.dumps(
                        {
                            "type": "suggestion_ready",
                            "data": {
                                "suggestion_id": str(suggestion.id),
                                "contact_id": str(contact_id),
                                "contact_name": contact_name,
                            },
                            "message": status_msg,
                        }
                    ),
                )
            finally:
                await redis_client.close()

    except Exception as e:
        logger.error(
            f"[CONSUMER] Auto-suggest failed for {contact_name}: {e}",
            exc_info=True,
        )


async def _process_message(msg_data: dict, redis_client: aioredis.Redis):
    """Process a single incoming message from Redis.

    When the user is globally paused, messages are still saved to DB
    (to prevent data loss) but heavy processing is skipped.
    """
    user_id_str = msg_data.get("user_id")
    if not user_id_str:
        return

    chat_id = msg_data.get("chat_id")
    chat_name = msg_data.get("chat_name", "Unknown")
    chat_type = msg_data.get("chat_type", "personal_chat")
    text = msg_data.get("text", "")
    is_sync = msg_data.get("is_sync", False)

    if not chat_id or not text:
        return

    async with async_session() as db:
        try:
            # Resolve user — user_id might be "default" (env-based session)
            # or a UUID (DB-based session)
            from app.models.user import User

            if user_id_str == "default":
                # Match by Telegram user ID (self_tg_id) from the message payload.
                # This is deterministic even with multiple users in the DB.
                self_tg_id = msg_data.get("self_tg_id")
                if self_tg_id:
                    stmt = select(User).where(
                        User.telegram_user_id == str(self_tg_id)
                    )
                    result = await db.execute(stmt)
                    user = result.scalar_one_or_none()
                else:
                    user = None

                if not user:
                    # Fallback: only safe when exactly one user with a session exists
                    count_stmt = select(func.count()).select_from(User).where(
                        User.telegram_session.isnot(None)
                    )
                    user_count = (await db.execute(count_stmt)).scalar() or 0
                    if user_count > 1:
                        logger.error(
                            "[CONSUMER] Refusing 'default' session: multiple users "
                            "have telegram sessions. Cannot determine target user. "
                            "Each user must authenticate via the dashboard."
                        )
                        return
                    stmt = select(User).where(
                        User.telegram_session.isnot(None)
                    ).limit(1)
                    result = await db.execute(stmt)
                    user = result.scalar_one_or_none()
                    if not user:
                        logger.warning(
                            "[CONSUMER] No user found for 'default' session"
                        )
                        return

                user_id = user.id
            else:
                try:
                    user_id = uuid.UUID(user_id_str)
                except ValueError:
                    logger.warning(f"[CONSUMER] Invalid user_id: {user_id_str}")
                    return

            contact = await _get_or_create_contact(
                db, user_id, chat_id, chat_name, chat_type
            )
            message = await _save_message(db, contact, msg_data)

            if message is None:
                return  # Duplicate

            await db.commit()

            is_incoming = msg_data.get("is_incoming", True)

            if not is_sync:
                logger.info(
                    f"[CONSUMER] Saved message from {msg_data.get('sender_name')} "
                    f"in {chat_name} (contact: {contact.id})"
                )

            # ── If user is globally paused, skip all heavy processing ──
            paused = await _is_user_paused(redis_client, user_id)
            if paused:
                logger.info(
                    f"[CONSUMER] PAUSED — message saved to DB but skipping "
                    f"rechunk/embed/suggest for {chat_name} "
                    f"(sync={is_sync}, user={user_id})"
                )
                # Still track pending rechunks so catch-up knows what to process
                count = _pending_rechunk.get(contact.id, 0) + 1
                _pending_rechunk[contact.id] = count
                return

            # Auto-generate suggestion ONLY for real-time incoming DMs
            # Skip: bulk sync, groups, supergroups, channels, bots
            # Also skip if user has disabled auto_generate in preferences
            is_dm = contact.chat_type in ("personal_chat",)
            if is_incoming and not is_sync and is_dm:
                from app.models.user import User as UserModel
                user_obj = await db.get(UserModel, user_id)
                user_prefs = (user_obj.settings or {}) if user_obj else {}
                auto_generate = user_prefs.get("auto_generate", True)
                auto_draft = user_prefs.get("auto_draft", True)
                if auto_generate:
                    logger.info(
                        f"[CONSUMER] Queuing auto-suggestion for {chat_name}"
                    )
                    asyncio.create_task(
                        _auto_generate_suggestion(
                            user_id, contact.id, chat_name,
                            auto_draft=auto_draft,
                            redis_client=redis_client,
                        )
                    )

            # Track pending re-chunks
            count = _pending_rechunk.get(contact.id, 0) + 1
            _pending_rechunk[contact.id] = count

            if not is_sync and count >= RECHUNK_THRESHOLD:
                logger.info(
                    f"[CONSUMER] Threshold hit ({count}/{RECHUNK_THRESHOLD}) — "
                    f"queuing rechunk for {chat_name}"
                )
                asyncio.create_task(
                    _rechunk_and_embed_contact(user_id, contact.id, redis_client)
                )

        except Exception as e:
            logger.error(f"[CONSUMER] Failed to process message: {e}", exc_info=True)
            await db.rollback()


async def _periodic_rechunk(redis_client: aioredis.Redis):
    """
    Periodically flush any pending re-chunks that haven't hit the threshold.
    Runs every 60 seconds. Limits concurrency to avoid DB pool exhaustion.
    Skips contacts whose user is globally paused.
    """
    try:
        while True:
            await asyncio.sleep(60)
            try:
                pending = dict(_pending_rechunk)
                if not pending:
                    continue

                logger.info(
                    f"[CONSUMER] Periodic flush: {len(pending)} contacts with pending messages"
                )

                # Process in batches of 3 to avoid DB pool exhaustion
                items = [(cid, cnt) for cid, cnt in pending.items() if cnt > 0]
                skipped_paused = 0
                queued = 0
                for i in range(0, len(items), 3):
                    batch = items[i : i + 3]
                    tasks = []
                    for contact_id, count in batch:
                        async with async_session() as db:
                            contact = await db.get(Contact, contact_id)
                            if contact:
                                # Skip if user is globally paused
                                if await _is_user_paused(redis_client, contact.user_id):
                                    skipped_paused += 1
                                    logger.info(
                                        f"[CONSUMER] PAUSED — skipping periodic rechunk "
                                        f"for {contact.display_name} ({count} pending msgs)"
                                    )
                                    continue
                                tasks.append(
                                    _rechunk_and_embed_contact(
                                        contact.user_id, contact_id, redis_client
                                    )
                                )
                                queued += 1
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)

                if skipped_paused:
                    logger.info(
                        f"[CONSUMER] Periodic flush done: {queued} processed, "
                        f"{skipped_paused} skipped (user paused)"
                    )
            except Exception as e:
                logger.error(f"[CONSUMER] Periodic rechunk error: {e}", exc_info=True)
    except asyncio.CancelledError:
        logger.info("[CONSUMER] Periodic rechunk task cancelled")
        raise


async def _listen_user_name_updates():
    """Listen for telegram:update_user_name:* events and persist to DB.

    Uses pattern subscription so it auto-captures all per-user channels.
    Uses get_message() with timeout instead of async generator to avoid
    'aclose(): asynchronous generator is already running' errors on shutdown.
    """
    from app.models.user import User

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis_client.pubsub()
    await pubsub.psubscribe("telegram:update_user_name:*")
    logger.info("[CONSUMER] Subscribed to telegram:update_user_name:*")

    try:
        while True:
            # Use get_message with timeout instead of async for to allow clean cancellation
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                # No message within timeout, check for cancellation
                await asyncio.sleep(0.1)
                continue
            if message["type"] != "pmessage":
                continue
            try:
                data = json.loads(message["data"])
                user_id = uuid.UUID(data["user_id"])
                new_name = data["name"]
                async with async_session() as db:
                    user = await db.get(User, user_id)
                    if user and user.name != new_name:
                        user.name = new_name
                        await db.commit()
                        logger.info(f"[CONSUMER] Updated user name to '{new_name}'")
            except Exception as e:
                logger.warning(f"[CONSUMER] Failed to update user name: {e}")
    except asyncio.CancelledError:
        logger.info("[CONSUMER] User name listener cancelled")
        raise
    finally:
        # Defensive cleanup — ignore errors during shutdown
        try:
            await pubsub.punsubscribe()
        except Exception:
            pass
        try:
            await pubsub.close()
        except Exception:
            pass
        try:
            await redis_client.close()
        except Exception:
            pass


async def run_catchup_processing(
    user_id: uuid.UUID,
    paused_at: datetime,
    redis_client: aioredis.Redis,
):
    """Catch-up processing after a pause/resume cycle.

    Finds all contacts that received new messages since `paused_at`,
    re-chunks and re-embeds them so nothing is missed.
    """
    logger.info(
        f"[CONSUMER] Starting catch-up processing for user {user_id} "
        f"from {paused_at.isoformat()}"
    )

    try:
        async with async_session() as db:
            # Find contacts that got new messages during the pause window
            stmt = (
                select(Contact)
                .where(
                    Contact.user_id == user_id,
                    Contact.last_message_at >= paused_at,
                )
            )
            result = await db.execute(stmt)
            contacts = result.scalars().all()

            if not contacts:
                logger.info("[CONSUMER] Catch-up: no contacts with new messages")
                return

            logger.info(
                f"[CONSUMER] Catch-up: {len(contacts)} contacts with messages "
                f"since {paused_at.isoformat()}"
            )

            # Publish progress to frontend
            await redis_client.publish(
                f"user:{str(user_id)}:events",
                json.dumps({
                    "type": "processing_status",
                    "message": f"Catching up — processing {len(contacts)} contacts...",
                }),
            )

            # Rechunk + embed each contact (batched to avoid DB pool exhaustion)
            processed = 0
            for i in range(0, len(contacts), 3):
                batch = contacts[i : i + 3]
                tasks = [
                    _rechunk_and_embed_contact(user_id, c.id, redis_client)
                    for c in batch
                ]
                await asyncio.gather(*tasks, return_exceptions=True)
                processed += len(batch)
                logger.info(
                    f"[CONSUMER] Catch-up progress: {processed}/{len(contacts)} contacts"
                )

            # Clear any stale pending rechunk counters for these contacts
            for c in contacts:
                _pending_rechunk.pop(c.id, None)

            logger.info(
                f"[CONSUMER] Catch-up complete: {processed} contacts re-chunked + embedded"
            )

            await redis_client.publish(
                f"user:{str(user_id)}:events",
                json.dumps({
                    "type": "processing_status",
                    "message": f"Catch-up complete — {processed} contacts processed.",
                }),
            )

    except Exception as e:
        logger.error(f"[CONSUMER] Catch-up failed: {e}", exc_info=True)


async def start_message_consumer():
    """
    Main consumer loop. Uses pattern subscription on telegram:new_messages:*
    to auto-capture messages from all per-user channels.
    Also starts a periodic re-chunk flusher.
    """
    logger.info("[CONSUMER] Starting real-time message consumer...")

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis_client.pubsub()
    await pubsub.psubscribe("telegram:new_messages:*")

    # Start periodic flusher (with redis access for pause checks)
    periodic_task = asyncio.create_task(_periodic_rechunk(redis_client))
    # Listen for user name updates from monitor
    user_name_task = asyncio.create_task(_listen_user_name_updates())

    logger.info("[CONSUMER] Subscribed to telegram:new_messages:*")

    try:
        while True:
            # Use get_message with timeout instead of async for to allow clean cancellation
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                await asyncio.sleep(0.1)
                continue
            if message["type"] == "pmessage":
                try:
                    msg_data = json.loads(message["data"])
                    await _process_message(msg_data, redis_client)
                except json.JSONDecodeError:
                    logger.warning("[CONSUMER] Invalid JSON in message")
                except Exception as e:
                    logger.error(f"[CONSUMER] Message processing error: {e}", exc_info=True)
    except asyncio.CancelledError:
        logger.info("[CONSUMER] Shutting down...")
    finally:
        # Cancel background tasks and wait for them to finish
        for task in (periodic_task, user_name_task):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        # Cleanup pubsub/redis connections
        try:
            await pubsub.punsubscribe()
        except Exception:
            pass
        try:
            await pubsub.close()
        except Exception:
            pass
        try:
            await redis_client.close()
        except Exception:
            pass
        logger.info("[CONSUMER] Stopped")
