"""
Real-time message consumer.

Subscribes to Redis `telegram:new_messages` channel and for each message:
1. Upserts contact in DB
2. Saves message to DB (dedup by telegram_msg_id)
3. Updates contact stats (total_messages, last_message_at, unresponded_count)
4. Periodically chunks + embeds recent messages for the contact
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

    # Update contact stats
    contact.total_messages = (contact.total_messages or 0) + 1
    contact.last_message_at = message.sent_at
    if is_incoming:
        contact.unresponded_count = (contact.unresponded_count or 0) + 1
    else:
        # User replied — reset unresponded count
        contact.unresponded_count = 0

    await db.flush()
    return message


async def _rechunk_and_embed_contact(
    user_id: uuid.UUID,
    contact_id: uuid.UUID,
):
    """Re-chunk and embed all messages for a contact."""
    lock = _rechunk_locks.setdefault(contact_id, asyncio.Lock())

    async with lock:
        async with async_session() as db:
            try:
                contact = await db.get(Contact, contact_id)
                if not contact:
                    return

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
                        contact_id=contact_id,
                        chunk_text=chunk.text,
                        session_start=chunk.start,
                        session_end=chunk.end,
                        message_count=chunk.count,
                    )
                    db.add(db_chunk)
                    db_chunks.append(db_chunk)

                await db.flush()

                # Embed all chunks
                texts = [c.chunk_text for c in db_chunks]
                if texts:
                    embeddings = await embed_texts(
                        texts,
                        input_type="document",
                        user_id=user_id,
                        operation="live_message_embed",
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
):
    """Auto-generate a response suggestion for a new incoming message.

    Guards:
    - Skips if there's already a pending suggestion for this contact
    - Wraps in try/except so failures never crash the consumer
    """
    try:
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

            suggestion = await generate_reply(
                db=db,
                user_id=user_id,
                contact_id=contact_id,
                user_name=user.name,
            )

            logger.info(
                f"[CONSUMER] Auto-suggestion {suggestion.id} created for {contact_name}"
            )

            # Look up contact's telegram_id so we can save draft
            contact = await db.get(Contact, contact_id)

            # Auto-save as Telegram draft immediately
            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            try:
                if contact:
                    await redis_client.publish(
                        "telegram:send_commands",
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
                            "message": f"Draft saved for {contact_name}",
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


async def _process_message(msg_data: dict):
    """Process a single incoming message from Redis."""
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
                # Find the first user with a telegram session
                stmt = select(User).where(User.telegram_session.isnot(None)).limit(1)
                result = await db.execute(stmt)
                user = result.scalar_one_or_none()
                if not user:
                    logger.warning("[CONSUMER] No user found for 'default' session")
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

            # Auto-generate suggestion ONLY for real-time incoming DMs
            # Skip: bulk sync, groups, supergroups, channels, bots
            is_dm = contact.chat_type in ("personal_chat",)
            if is_incoming and not is_sync and is_dm:
                asyncio.create_task(
                    _auto_generate_suggestion(user_id, contact.id, chat_name)
                )

            # Track pending re-chunks
            count = _pending_rechunk.get(contact.id, 0) + 1
            _pending_rechunk[contact.id] = count

            if not is_sync and count >= RECHUNK_THRESHOLD:
                # Fire-and-forget re-chunk task (during sync, periodic flush handles it)
                asyncio.create_task(
                    _rechunk_and_embed_contact(user_id, contact.id)
                )

        except Exception as e:
            logger.error(f"[CONSUMER] Failed to process message: {e}", exc_info=True)
            await db.rollback()


async def _periodic_rechunk():
    """
    Periodically flush any pending re-chunks that haven't hit the threshold.
    Runs every 60 seconds. Limits concurrency to avoid DB pool exhaustion.
    """
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
            for i in range(0, len(items), 3):
                batch = items[i : i + 3]
                tasks = []
                for contact_id, _ in batch:
                    async with async_session() as db:
                        contact = await db.get(Contact, contact_id)
                        if contact:
                            tasks.append(
                                _rechunk_and_embed_contact(contact.user_id, contact_id)
                            )
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            logger.error(f"[CONSUMER] Periodic rechunk error: {e}", exc_info=True)


async def _listen_user_name_updates():
    """Listen for telegram:update_user_name events and persist to DB."""
    from app.models.user import User

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("telegram:update_user_name")
    logger.info("[CONSUMER] Subscribed to telegram:update_user_name")

    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
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
        pass
    finally:
        await pubsub.unsubscribe()
        await pubsub.close()
        await redis_client.close()


async def start_message_consumer():
    """
    Main consumer loop. Subscribes to telegram:new_messages and processes
    each message. Also starts a periodic re-chunk flusher.
    """
    logger.info("[CONSUMER] Starting real-time message consumer...")

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("telegram:new_messages")

    # Start periodic flusher
    asyncio.create_task(_periodic_rechunk())
    # Listen for user name updates from monitor
    asyncio.create_task(_listen_user_name_updates())

    logger.info("[CONSUMER] Subscribed to telegram:new_messages")

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                try:
                    msg_data = json.loads(message["data"])
                    await _process_message(msg_data)
                except json.JSONDecodeError:
                    logger.warning("[CONSUMER] Invalid JSON in message")
                except Exception as e:
                    logger.error(f"[CONSUMER] Message processing error: {e}", exc_info=True)
    except asyncio.CancelledError:
        logger.info("[CONSUMER] Shutting down...")
    finally:
        await pubsub.unsubscribe()
        await pubsub.close()
        await redis_client.close()
        logger.info("[CONSUMER] Stopped")
