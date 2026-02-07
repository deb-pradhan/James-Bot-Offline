"""
Telegram chat history ingestion service.

Pipeline:
1. Parse JSON export
2. Create contacts + messages in DB
3. Chunk conversations into session-based chunks
4. Embed chunks via Voyage AI
5. Trigger style analysis per contact
"""

import json
import logging
import uuid
from datetime import datetime, timedelta
from dataclasses import dataclass
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
import redis.asyncio as aioredis

from app.models.contact import Contact
from app.models.message import Message
from app.models.chunk import ConversationChunk
from app.services.embedding import embed_texts
from app.services.style_analyzer import analyze_contact_style
from app.utils.telegram_export import parse_telegram_export, ParsedChat
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


async def publish_status(
    redis_client: aioredis.Redis,
    user_id: str,
    step: str,
    message: str,
    progress: int | None = None,
    total: int | None = None,
):
    """Publish ingestion status update to Redis for WebSocket relay."""
    import json as _json

    event = {
        "type": "ingestion_progress",
        "data": {
            "step": step,
            "progress": progress,
            "total": total,
        },
        "message": message,
    }
    await redis_client.publish(f"user:{user_id}:events", _json.dumps(event))


async def ingest_telegram_export(
    db: AsyncSession,
    redis_client: aioredis.Redis,
    user_id: uuid.UUID,
    file_content: bytes,
    user_name: str,
    self_user_id_override: str | None = None,
) -> dict:
    """
    Full ingestion pipeline. Returns summary stats.

    This runs as a background task — publishes progress to Redis.
    """
    user_id_str = str(user_id)

    # ── Step 1: Parse JSON ──
    await publish_status(redis_client, user_id_str, "parsing", "Parsing Telegram export...")
    try:
        data = json.loads(file_content)
    except json.JSONDecodeError as e:
        logger.error(f"[INGEST] Invalid JSON: {e}")
        raise ValueError(f"Invalid JSON file: {e}")

    parsed_chats, detected_self_id = parse_telegram_export(data)
    self_id = self_user_id_override or detected_self_id

    if not parsed_chats:
        raise ValueError("No chats found in the export file")

    logger.info(
        f"[INGEST] Starting ingestion: {len(parsed_chats)} chats, self_id={self_id}"
    )

    # ── Step 2: Create contacts + messages ──
    total_chats = len(parsed_chats)
    total_messages = 0
    contacts_created = []

    for i, chat in enumerate(parsed_chats):
        await publish_status(
            redis_client,
            user_id_str,
            "importing",
            f"Importing chat {i + 1}/{total_chats}: {chat.chat_name}",
            progress=i + 1,
            total=total_chats,
        )

        # Upsert contact
        contact = await get_or_create_contact(db, user_id, chat)
        contacts_created.append(contact)

        # Batch insert messages
        msg_count = 0
        for msg in chat.messages:
            sender_type = "self" if msg.sender_id == self_id else "other"
            db_msg = Message(
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

        contact.total_messages = (contact.total_messages or 0) + msg_count
        if chat.messages:
            contact.last_message_at = max(m.sent_at for m in chat.messages)
        total_messages += msg_count

        # Flush every 10 chats to avoid memory bloat
        if (i + 1) % 10 == 0:
            await db.flush()

    await db.commit()
    logger.info(f"[INGEST] Imported {total_messages} messages across {total_chats} chats")

    # ── Step 3: Chunk conversations ──
    await publish_status(
        redis_client, user_id_str, "chunking", "Chunking conversations..."
    )

    total_chunks = 0
    for i, contact in enumerate(contacts_created):
        await publish_status(
            redis_client,
            user_id_str,
            "chunking",
            f"Chunking contact {i + 1}/{len(contacts_created)}: {contact.display_name}",
            progress=i + 1,
            total=len(contacts_created),
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
                    contact_id=contact.id,
                    chunk_text=chunk.text,
                    session_start=chunk.start,
                    session_end=chunk.end,
                    message_count=chunk.count,
                )
            )
            total_chunks += 1

    await db.commit()
    logger.info(f"[INGEST] Created {total_chunks} conversation chunks")

    # ── Step 4: Embed chunks ──
    await publish_status(
        redis_client, user_id_str, "embedding", "Generating embeddings..."
    )

    # Fetch all unembedded chunks for this user
    stmt = (
        select(ConversationChunk)
        .join(Contact, ConversationChunk.contact_id == Contact.id)
        .where(Contact.user_id == user_id)
        .where(ConversationChunk.embedding.is_(None))
    )
    result = await db.execute(stmt)
    unembedded = result.scalars().all()

    batch_size = 64
    for i in range(0, len(unembedded), batch_size):
        batch = unembedded[i : i + batch_size]
        await publish_status(
            redis_client,
            user_id_str,
            "embedding",
            f"Embedding chunks {min(i + batch_size, len(unembedded))}/{len(unembedded)}",
            progress=min(i + batch_size, len(unembedded)),
            total=len(unembedded),
        )

        texts = [c.chunk_text for c in batch]
        embeddings = await embed_texts(texts, input_type="document")

        for chunk, emb in zip(batch, embeddings):
            chunk.embedding = emb

        await db.commit()

    logger.info(f"[INGEST] Embedded {len(unembedded)} chunks")

    # ── Step 5: Style analysis ──
    await publish_status(
        redis_client,
        user_id_str,
        "analyzing",
        "Analyzing communication style per contact...",
    )

    for i, contact in enumerate(contacts_created):
        await publish_status(
            redis_client,
            user_id_str,
            "analyzing",
            f"Analyzing style for {contact.display_name} ({i + 1}/{len(contacts_created)})",
            progress=i + 1,
            total=len(contacts_created),
        )

        try:
            style = await analyze_contact_style(db, user_id, contact, user_name)
            contact.style_profile = style
        except Exception as e:
            logger.warning(
                f"[INGEST] Style analysis failed for {contact.display_name}: {e}"
            )

    await db.commit()

    # ── Done ──
    summary = {
        "chats": total_chats,
        "messages": total_messages,
        "contacts": len(contacts_created),
        "chunks": total_chunks,
    }

    await publish_status(
        redis_client,
        user_id_str,
        "complete",
        f"Ingestion complete! {total_chats} chats, {total_messages} messages, "
        f"{total_chunks} chunks indexed.",
    )

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
