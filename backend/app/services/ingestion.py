"""
Telegram chat history ingestion service.

Pipeline:
1. Parse JSON export
2. Create contacts + messages in DB
3. Chunk conversations into session-based chunks
4. Embed chunks via Voyage AI
5. Trigger style analysis per contact
"""

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta
from dataclasses import dataclass
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
import redis.asyncio as aioredis

from app.models.contact import Contact
from app.models.message import Message
from app.models.chunk import ConversationChunk
from app.services.embedding import embed_texts
from app.services.style_analyzer import analyze_contact_style
from app.utils.telegram_export import parse_telegram_export, ParsedChat, ExportMetadata
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

SESSION_GAP_HOURS = 4  # Messages > 4h apart = new conversation session
MAX_CHUNK_TOKENS = 800  # Approximate max tokens per chunk


@dataclass
class ChunkData:
    text: str
    start: datetime
    end: datetime
    count: int


class IngestionCancelled(Exception):
    """Raised when user requested a full ingestion stop."""


async def publish_status(
    redis_client: aioredis.Redis,
    user_id: str,
    step: str,
    message: str,
    progress: int | None = None,
    total: int | None = None,
    *,
    stats: dict | None = None,
    db: AsyncSession | None = None,
    job_id: uuid.UUID | None = None,
):
    """Publish ingestion status update to Redis and persist to DB."""
    import json as _json

    event = {
        "type": "ingestion_progress",
        "data": {
            "step": step,
            "progress": progress,
            "total": total,
            "stats": stats,
        },
        "message": message,
    }
    await redis_client.publish(f"user:{user_id}:events", _json.dumps(event))

    # Persist to DB for reconnect recovery
    if db and job_id:
        from app.models.job import IngestionJob

        stmt = (
            select(IngestionJob).where(IngestionJob.id == job_id).with_for_update()
        )
        result = await db.execute(stmt)
        job = result.scalar_one_or_none()
        if job:
            job.step = step
            job.progress = progress
            job.total = total
            job.message = message
            await db.commit()


async def ingest_telegram_export(
    db: AsyncSession,
    redis_client: aioredis.Redis,
    user_id: uuid.UUID,
    file_content: bytes,
    user_name: str,
    self_user_id_override: str | None = None,
    job_id: uuid.UUID | None = None,
    filename: str | None = None,
    model: str | None = None,
    user_settings: dict | None = None,
) -> dict:
    """
    Full ingestion pipeline. Returns summary stats.

    This runs as a background task — publishes progress to Redis.
    """
    import asyncio as _asyncio

    user_id_str = str(user_id)
    cancel_job_key = f"ingest:cancel_job:{user_id_str}"
    pause_key = f"user:paused:{user_id_str}"

    # Live stats dict — sent with every progress event
    stats = {
        "contacts_processed": 0,
        "messages_synced": 0,
        "duplicates_skipped": 0,
        "chunks_created": 0,
        "embeddings_generated": 0,
        "styles_analyzed": 0,
    }

    async def _status(step: str, message: str, progress: int | None = None, total: int | None = None):
        await publish_status(
            redis_client, user_id_str, step, message,
            progress=progress, total=total, stats=stats, db=db, job_id=job_id,
        )

    async def _update_job_status(new_status: str):
        """Update only the status field of the job row."""
        if not job_id:
            return
        from app.models.job import IngestionJob

        stmt = select(IngestionJob).where(IngestionJob.id == job_id).with_for_update()
        result = await db.execute(stmt)
        job = result.scalar_one_or_none()
        if job:
            job.status = new_status
            await db.commit()

    async def _raise_if_cancelled(
        step: str,
        progress: int | None = None,
        total: int | None = None,
    ):
        if await redis_client.exists(cancel_job_key):
            await redis_client.delete(cancel_job_key)
            # NOTE: Do NOT clear pause_key — /stop intentionally sets user:paused
            # so background processing stays paused until the user explicitly resumes.
            await _status(
                step,
                "Ingestion stopped by user.",
                progress=progress,
                total=total,
            )
            raise IngestionCancelled()

    async def _wait_if_paused(
        step: str,
        progress: int | None = None,
        total: int | None = None,
    ):
        """Block the pipeline while the pause flag is set. Cancel still works."""
        if not await redis_client.exists(pause_key):
            return
        # Publish paused status + update job row
        await _status(step, "Paused", progress=progress, total=total)
        await _update_job_status("paused")
        # Spin-wait with 1s sleep, checking for cancel
        while await redis_client.exists(pause_key):
            if await redis_client.exists(cancel_job_key):
                # Don't delete pause_key — /stop keeps it set intentionally
                await _raise_if_cancelled(step, progress, total)
            await _asyncio.sleep(1)
        # Resumed
        await _update_job_status("processing")
        await _status(step, "Resumed", progress=progress, total=total)

    # Clear any stale stop flag from previous ingestion runs
    # NOTE: Do NOT clear pause_key here — it's the global user:paused flag
    # shared by all services. Clearing it would silently unpause the user.
    await redis_client.delete(cancel_job_key)

    # ── Step 1: Parse JSON ──
    await _status("parsing", "Parsing Telegram export...")

    # Compute file hash for duplicate detection
    file_hash = hashlib.sha256(file_content).hexdigest()

    try:
        data = json.loads(file_content)
    except json.JSONDecodeError as e:
        logger.error(f"[INGEST] Invalid JSON: {e}")
        raise ValueError(f"Invalid JSON file: {e}")

    parsed_chats, detected_self_id, export_meta = parse_telegram_export(data)
    self_id = self_user_id_override or detected_self_id

    if not parsed_chats:
        raise ValueError("No chats found in the export file")

    logger.info(
        f"[INGEST] Starting ingestion: {len(parsed_chats)} chats, self_id={self_id}, "
        f"date range: {export_meta.chat_date_start} → {export_meta.chat_date_end}"
    )

    # Persist history metadata on the job row
    if job_id:
        from app.models.job import IngestionJob

        stmt = select(IngestionJob).where(IngestionJob.id == job_id)
        result = await db.execute(stmt)
        job = result.scalar_one_or_none()
        if job:
            job.filename = filename
            job.file_hash = file_hash
            job.chat_date_start = export_meta.chat_date_start
            job.chat_date_end = export_meta.chat_date_end
            job.total_messages_in_file = export_meta.total_messages
            await db.commit()

    # ── Step 2: Create contacts + messages ──
    total_chats = len(parsed_chats)
    total_messages = 0
    total_skipped = 0
    contacts_created = []
    total_chunks = 0
    total_embedded = 0
    cancelled = False

    try:
        for i, chat in enumerate(parsed_chats):
            await _raise_if_cancelled("importing", progress=i, total=total_chats)
            await _wait_if_paused("importing", progress=i, total=total_chats)
            await _status(
                "importing",
                f"Syncing: {chat.chat_name}",
                progress=i + 1,
                total=total_chats,
            )

            # Upsert contact
            contact = await get_or_create_contact(db, user_id, chat)
            contacts_created.append(contact)

            # Fetch existing telegram_msg_ids to skip duplicates
            existing_stmt = select(Message.telegram_msg_id).where(
                Message.contact_id == contact.id,
                Message.telegram_msg_id.isnot(None),
            )
            existing_result = await db.execute(existing_stmt)
            existing_msg_ids = set(existing_result.scalars().all())

            # Insert only new messages
            msg_count = 0
            for msg in chat.messages:
                if msg.telegram_msg_id in existing_msg_ids:
                    continue
                sender_type = "self" if msg.sender_id == self_id else "other"
                db_msg = Message(
                    user_id=user_id,
                    contact_id=contact.id,
                    telegram_msg_id=msg.telegram_msg_id,
                    sender_type=sender_type,
                    sender_name=msg.sender_name,
                    content=msg.text,
                    sent_at=msg.sent_at,
                    is_read=True,
                    is_responded=True,  # Historical msgs are already responded to
                )
                db.add(db_msg)
                msg_count += 1

            skipped = len(chat.messages) - msg_count
            total_skipped += skipped
            if skipped > 0:
                logger.info(
                    f"[INGEST] {chat.chat_name}: {msg_count} new, {skipped} skipped (already exist)"
                )
            if msg_count > 0:
                contact.total_messages = (contact.total_messages or 0) + msg_count
            if chat.messages:
                contact.last_message_at = max(m.sent_at for m in chat.messages)
            total_messages += msg_count

            # Update live stats
            stats["contacts_processed"] = i + 1
            stats["messages_synced"] = total_messages
            stats["duplicates_skipped"] = total_skipped

            # Flush every 10 chats to avoid memory bloat
            if (i + 1) % 10 == 0:
                await db.flush()

        await db.commit()
        logger.info(
            f"[INGEST] Imported {total_messages} messages across {total_chats} chats "
            f"({total_skipped} duplicates skipped)"
        )

        # ── Step 3: Chunk conversations ──
        await _status("chunking", "Chunking conversations...")

        for i, contact in enumerate(contacts_created):
            await _raise_if_cancelled(
                "chunking", progress=i, total=len(contacts_created)
            )
            await _wait_if_paused(
                "chunking", progress=i, total=len(contacts_created)
            )
            await _status(
                "chunking",
                f"Chunking: {contact.display_name}",
                progress=i + 1,
                total=len(contacts_created),
            )

            # Delete old chunks for this contact (they'll be rebuilt from all messages)
            await db.execute(
                delete(ConversationChunk).where(
                    ConversationChunk.contact_id == contact.id
                )
            )

            # Fetch all messages for this contact, ordered by time
            stmt = (
                select(Message)
                .where(Message.contact_id == contact.id)
                .order_by(Message.sent_at)
            )
            result = await db.execute(stmt)
            messages = result.scalars().all()

            chunks = create_conversation_chunks(messages)
            for chunk in chunks:
                db.add(
                    ConversationChunk(
                        user_id=user_id,
                        contact_id=contact.id,
                        chunk_text=chunk.text,
                        session_start=chunk.start,
                        session_end=chunk.end,
                        message_count=chunk.count,
                    )
                )
                total_chunks += 1

            # Update live stats
            stats["chunks_created"] = total_chunks

        await db.commit()
        logger.info(f"[INGEST] Created {total_chunks} conversation chunks")

        # ── Step 4: Embed chunks ──
        await _status("embedding", "Generating embeddings...")

        # Fetch all unembedded chunks for this user
        stmt = (
            select(ConversationChunk)
            .join(Contact, ConversationChunk.contact_id == Contact.id)
            .where(Contact.user_id == user_id)
            .where(ConversationChunk.embedding.is_(None))
        )
        result = await db.execute(stmt)
        unembedded = result.scalars().all()

        batch_size = 16  # Small batches to stay within free-tier rate limits
        for i in range(0, len(unembedded), batch_size):
            await _raise_if_cancelled(
                "embedding",
                progress=min(i, len(unembedded)),
                total=len(unembedded),
            )
            await _wait_if_paused(
                "embedding",
                progress=min(i, len(unembedded)),
                total=len(unembedded),
            )
            batch = unembedded[i : i + batch_size]
            await _status(
                "embedding",
                "Generating embeddings...",
                progress=min(i + batch_size, len(unembedded)),
                total=len(unembedded),
            )

            texts = [c.chunk_text for c in batch]
            embeddings = await embed_texts(
                texts, input_type="document",
                user_id=user_id, operation="embedding_ingest",
                user_settings=user_settings,
            )

            for chunk, emb in zip(batch, embeddings):
                chunk.embedding = emb

            total_embedded += len(batch)
            stats["embeddings_generated"] = total_embedded

            await db.commit()

        logger.info(f"[INGEST] Embedded {len(unembedded)} chunks")

        # ── Step 5: Style analysis (DMs only) ──
        dm_contacts = [c for c in contacts_created if c.chat_type == "personal_chat"]
        skipped_count = len(contacts_created) - len(dm_contacts)

        if skipped_count > 0:
            logger.info(
                f"[INGEST] Skipping style analysis for {skipped_count} non-DM contacts "
                f"(groups/channels)"
            )

        if not dm_contacts:
            await _status(
                "analyzing",
                "No individual DMs to analyze — skipping style analysis.",
            )
        else:
            cancel_key = f"ingest:cancel_analysis:{user_id_str}"
            # Clear any stale cancel flag from a previous run
            await redis_client.delete(cancel_key)

            await _status(
                "analyzing",
                f"Analyzing communication styles...",
            )

            for i, contact in enumerate(dm_contacts):
                await _raise_if_cancelled("analyzing", progress=i, total=len(dm_contacts))
                await _wait_if_paused("analyzing", progress=i, total=len(dm_contacts))
                # Check for analysis-only cancellation
                if await redis_client.exists(cancel_key):
                    logger.info(f"[INGEST] Style analysis cancelled by user at {i}/{len(dm_contacts)}")
                    await _status(
                        "analyzing",
                        f"Style analysis stopped by user. Analyzed {i}/{len(dm_contacts)} contacts.",
                        progress=i,
                        total=len(dm_contacts),
                    )
                    await redis_client.delete(cancel_key)
                    break

                await _status(
                    "analyzing",
                    f"Analyzing: {contact.display_name}",
                    progress=i + 1,
                    total=len(dm_contacts),
                )

                try:
                    style = await analyze_contact_style(
                        db,
                        user_id,
                        contact,
                        user_name,
                        model=model,
                        user_settings=user_settings,
                    )
                    contact.style_profile = style
                    stats["styles_analyzed"] = i + 1
                except Exception as e:
                    logger.warning(
                        f"[INGEST] Style analysis failed for {contact.display_name}: {e}"
                    )

        await db.commit()
    except IngestionCancelled:
        cancelled = True
        await db.commit()

    # ── Done ──
    summary = {
        "chats": total_chats,
        "messages": total_messages,
        "messages_skipped": total_skipped,
        "contacts": len(contacts_created),
        "chunks": total_chunks,
        "embeddings": total_embedded,
        "styles_analyzed": stats["styles_analyzed"],
    }

    if cancelled:
        logger.info("[INGEST] Ingestion cancelled by user")
        summary["stopped"] = 1
        await _status(
            "complete",
            f"Ingestion stopped by user. Imported {total_messages} messages "
            f"({total_skipped} duplicates skipped), indexed {total_chunks} chunks.",
        )
    else:
        await _status(
            "complete",
            f"Ingestion complete! {total_chats} chats, {total_messages} new messages "
            f"({total_skipped} duplicates skipped), {total_chunks} chunks indexed.",
        )

    # Mark job complete in DB
    if job_id:
        from app.models.job import IngestionJob

        stmt = select(IngestionJob).where(IngestionJob.id == job_id)
        result = await db.execute(stmt)
        job = result.scalar_one_or_none()
        if job:
            job.status = "complete"
            job.result = summary
            job.messages_skipped = total_skipped
            await db.commit()

    # Publish completion event separately
    import json as _json

    await redis_client.publish(
        f"user:{user_id_str}:events",
        _json.dumps({"type": "ingestion_complete", "data": summary}),
    )

    logger.info(f"[INGEST] Ingestion complete: {summary}")
    return summary


async def get_or_create_contact(
    db: AsyncSession,
    user_id: uuid.UUID,
    chat: ParsedChat,
) -> Contact:
    """Find existing contact or create a new one."""
    stmt = select(Contact).where(
        Contact.user_id == user_id,
        Contact.telegram_id == chat.telegram_chat_id,
    )
    result = await db.execute(stmt)
    contact = result.scalar_one_or_none()

    if contact:
        return contact

    contact = Contact(
        user_id=user_id,
        telegram_id=chat.telegram_chat_id,
        display_name=chat.chat_name or f"Chat {chat.telegram_chat_id}",
        chat_type=chat.chat_type,
    )
    db.add(contact)
    await db.flush()
    logger.info(f"[INGEST] Created contact: {chat.chat_name} ({chat.telegram_chat_id})")
    return contact


def create_conversation_chunks(messages: list[Message]) -> list[ChunkData]:
    """
    Split messages into conversation session chunks.

    Rules:
    - Messages > SESSION_GAP_HOURS apart = new session
    - Each chunk is formatted with speaker labels and timestamps
    - Large sessions are split into smaller chunks (~MAX_CHUNK_TOKENS)
    """
    if not messages:
        return []

    sessions: list[list[Message]] = []
    current_session: list[Message] = [messages[0]]

    for msg in messages[1:]:
        gap = msg.sent_at - current_session[-1].sent_at
        if gap > timedelta(hours=SESSION_GAP_HOURS):
            sessions.append(current_session)
            current_session = [msg]
        else:
            current_session.append(msg)

    if current_session:
        sessions.append(current_session)

    # Format each session into chunks
    chunks: list[ChunkData] = []
    for session in sessions:
        text = format_session(session)

        # If the session text is too long, split it
        if len(text) > MAX_CHUNK_TOKENS * 4:  # Rough char-to-token ratio
            sub_chunks = split_text(text, MAX_CHUNK_TOKENS * 4)
            for sub in sub_chunks:
                chunks.append(
                    ChunkData(
                        text=sub,
                        start=session[0].sent_at,
                        end=session[-1].sent_at,
                        count=len(session),
                    )
                )
        else:
            chunks.append(
                ChunkData(
                    text=text,
                    start=session[0].sent_at,
                    end=session[-1].sent_at,
                    count=len(session),
                )
            )

    return chunks


def format_session(messages: list[Message]) -> str:
    """Format a conversation session with speaker labels and timestamps."""
    lines = []
    for msg in messages:
        ts = msg.sent_at.strftime("%Y-%m-%d %H:%M")
        lines.append(f"[{ts}] {msg.sender_name}: {msg.content}")
    return "\n".join(lines)


def split_text(text: str, max_chars: int) -> list[str]:
    """Split text into chunks of max_chars, breaking at newlines."""
    chunks = []
    current = ""
    for line in text.split("\n"):
        if len(current) + len(line) + 1 > max_chars and current:
            chunks.append(current.strip())
            # Keep some overlap for context
            overlap_lines = current.strip().split("\n")[-3:]
            current = "\n".join(overlap_lines) + "\n"
        current += line + "\n"
    if current.strip():
        chunks.append(current.strip())
    return chunks
