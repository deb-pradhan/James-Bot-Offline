"""
Full RAG pipeline for generating ghostwritten responses.

Orchestrates: retrieval → prompt building → Claude generation
"""

import logging
import re
import statistics
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from app.models.contact import Contact
from app.models.message import Message
from app.models.suggestion import ResponseSuggestion
from app.services.retrieval import retrieve_relevant_chunks
from app.services.llm import (
    generate_response,
    GHOSTWRITE_SYSTEM,
    GHOSTWRITE_USER,
    QUERY_SYSTEM,
    QUERY_USER,
)

logger = logging.getLogger(__name__)

RECENT_MESSAGES_LIMIT = 20


def _safe_parse_iso(iso_str: str | None) -> datetime | None:
    """Parse ISO datetime strings from retrieval payloads."""
    if not iso_str:
        return None
    try:
        normalized = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _extract_pending_incoming_window(messages: list[Message]) -> list[Message]:
    """
    Return incoming messages since the last outgoing user message.
    This approximates what still needs to be answered right now.
    """
    last_self_idx = -1
    for i, msg in enumerate(messages):
        if msg.sender_type == "self":
            last_self_idx = i
    window = messages[last_self_idx + 1 :] if last_self_idx >= 0 else messages
    return [msg for msg in window if msg.sender_type == "other"]


def _extract_open_questions(messages: list[Message], limit: int = 3) -> list[str]:
    """Extract likely unresolved questions from the pending incoming window."""
    pending = _extract_pending_incoming_window(messages)
    questions = []
    for msg in pending:
        text = (msg.content or "").strip()
        if "?" in text:
            questions.append(text)
    return questions[-limit:]


def _extract_action_signals(text: str) -> list[str]:
    """Extract lightweight action/constraint signals from message text."""
    if not text:
        return []

    lowered = text.lower()
    signals = []

    # Time/date urgency
    if re.search(r"\b(today|tonight|tomorrow|asap|urgent|deadline|by \d{1,2}(:\d{2})?)\b", lowered):
        signals.append("Contains time-sensitive cue")

    # Scheduling intent
    if re.search(r"\b(call|meet|meeting|schedule|book|available|availability)\b", lowered):
        signals.append("Likely scheduling/availability coordination")

    # Transactional requests
    if re.search(r"\b(send|share|forward|upload|link|file|invoice|payment|confirm)\b", lowered):
        signals.append("Likely expects concrete action or confirmation")

    # Numeric details worth preserving in a reply
    if re.search(r"\b\d+([.,]\d+)?\b", text):
        signals.append("Includes numeric details (keep values precise)")

    return signals


def _estimate_target_length(messages: list[Message]) -> int:
    """
    Estimate ideal reply length from this contact thread.
    Uses median of user's recent outgoing messages to keep drafts natural + efficient.
    """
    own_lengths = [
        len((msg.content or "").strip())
        for msg in messages
        if msg.sender_type == "self" and (msg.content or "").strip()
    ]
    if not own_lengths:
        return 120
    try:
        return int(max(35, min(280, statistics.median(own_lengths))))
    except statistics.StatisticsError:
        return 120


def _build_priority_brief(
    recent_msgs: list[Message],
    last_incoming_text: str,
    user_instruction: str | None,
) -> str:
    """
    Build a compact UX brief that tells the model what to solve first.
    """
    open_questions = _extract_open_questions(recent_msgs)
    action_signals = _extract_action_signals(last_incoming_text)
    target_len = _estimate_target_length(recent_msgs)

    sections = [
        "## Reply Priority Brief",
        f"- Primary target: answer the latest inbound message first.",
        f"- Target length: around {target_len} characters unless message complexity requires more.",
        "- Preferred ordering in the reply: direct answer → key detail(s) → clear next step/question.",
        "- Keep one-screen Telegram readability: short sentences, no fluff, no repetition.",
    ]

    if open_questions:
        sections.append("- Open questions to resolve (newest first):")
        sections.extend([f"  - {q}" for q in reversed(open_questions)])

    if action_signals:
        sections.append("- Message signals:")
        sections.extend([f"  - {signal}" for signal in action_signals])

    if user_instruction:
        sections.append("- Explicit user direction is highest priority if provided.")

    return "\n".join(sections)


def _compose_retrieval_query(
    recent_msgs: list[Message],
    last_incoming_text: str,
    user_instruction: str | None,
) -> str:
    """
    Build a higher-quality retrieval query than just the last message.
    Includes unresolved questions and optional user instruction.
    """
    pending = _extract_pending_incoming_window(recent_msgs)
    pending_tail = "\n".join(
        (m.content or "").strip()
        for m in pending[-3:]
        if (m.content or "").strip()
    )
    open_questions = " | ".join(_extract_open_questions(recent_msgs, limit=3))
    instruction_text = (user_instruction or "").strip()

    parts = [
        f"Latest inbound: {last_incoming_text.strip()}",
    ]
    if pending_tail:
        parts.append(f"Pending thread context: {pending_tail}")
    if open_questions:
        parts.append(f"Unresolved questions: {open_questions}")
    if instruction_text:
        parts.append(f"User direction: {instruction_text}")
    return "\n".join(parts)


def _rerank_conversation_chunks_by_recency(chunks: list[dict]) -> list[dict]:
    """
    Apply a small recency boost on top of vector score.
    Keeps high semantic relevance while preferring fresher patterns for replies.
    """
    now = datetime.now(timezone.utc)
    rescored: list[dict] = []

    for chunk in chunks:
        base = float(chunk.get("score", 0.0))
        session_end = _safe_parse_iso(chunk.get("session_end"))
        session_start = _safe_parse_iso(chunk.get("session_start"))
        anchor = session_end or session_start

        if anchor is None:
            recency_bonus = 0.0
        else:
            days_old = max(0.0, (now - anchor).total_seconds() / 86400.0)
            # Up to +0.12 bonus for very recent chunks, fades over ~45 days.
            recency_bonus = max(0.0, (45.0 - days_old) / 45.0) * 0.12

        combined = base + recency_bonus
        item = dict(chunk)
        item["combined_score"] = combined
        rescored.append(item)

    rescored.sort(key=lambda x: x.get("combined_score", x.get("score", 0.0)), reverse=True)
    return rescored


def _normalize_suggested_text(text: str) -> str:
    """Trim wrapper artifacts when model returns labels/quotes."""
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^\s*(Reply|Response|Message)\s*:\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
        cleaned = cleaned[1:-1].strip()
    return cleaned


async def generate_reply(
    db: AsyncSession,
    user_id: uuid.UUID,
    contact_id: uuid.UUID,
    user_name: str,
    user_instruction: str | None = None,
    model: str | None = None,
    user_settings: dict | None = None,
) -> ResponseSuggestion:
    """
    Generate a ghostwritten reply for a specific contact.

    1. Fetch recent messages
    2. Retrieve relevant context via RAG
    3. Build prompt with style profile
    4. Call Claude
    5. Store as pending suggestion
    """
    logger.info(f"[RESPOND] Generating reply for contact {contact_id}")

    # Fetch contact info
    contact = await db.get(Contact, contact_id)
    if not contact:
        raise ValueError(f"Contact {contact_id} not found")
    if contact.user_id != user_id:
        raise ValueError(f"Contact {contact_id} does not belong to user {user_id}")

    # Fetch recent messages
    stmt = (
        select(Message)
        .where(Message.contact_id == contact_id)
        .order_by(desc(Message.sent_at))
        .limit(RECENT_MESSAGES_LIMIT)
    )
    result = await db.execute(stmt)
    recent_msgs = list(reversed(result.scalars().all()))

    if not recent_msgs:
        raise ValueError(f"No messages found for contact {contact.display_name}")

    # Format recent messages for prompt
    recent_formatted = format_messages(recent_msgs)

    # Build query from last incoming message for RAG retrieval
    last_incoming = None
    for msg in reversed(recent_msgs):
        if msg.sender_type == "other":
            last_incoming = msg
            break

    base_query = last_incoming.content if last_incoming else recent_msgs[-1].content
    query_text = _compose_retrieval_query(recent_msgs, base_query, user_instruction)

    # Retrieve relevant context
    logger.info("[RESPOND] Retrieving relevant context...")
    context = await retrieve_relevant_chunks(
        db,
        user_id,
        query_text,
        contact_id=contact_id,
        top_k=8,
        user_settings=user_settings,
    )

    # Slightly prefer recent chunks to reduce stale-but-similar retrieval artifacts
    context["conversation_chunks"] = _rerank_conversation_chunks_by_recency(
        context["conversation_chunks"]
    )

    # Format context for prompt
    conv_context = format_context_chunks(context["conversation_chunks"])
    doc_context = format_context_chunks(context["document_chunks"], is_doc=True)

    style_profile = contact.style_profile or "No style profile available yet. Use a casual, friendly tone."

    # Build prompts
    system_prompt = GHOSTWRITE_SYSTEM.format(
        user_name=user_name,
        contact_name=contact.display_name,
        style_profile=style_profile,
        retrieved_context=conv_context or "No relevant past conversations found.",
        document_context=doc_context or "No relevant documents found.",
    )

    # Build user instruction section if provided
    instruction_block = ""
    if user_instruction:
        instruction_block = f"\n\n## User's Direction:\n{user_instruction}\nFollow this direction while staying in character as {user_name}."

    priority_brief = _build_priority_brief(
        recent_msgs=recent_msgs,
        last_incoming_text=base_query,
        user_instruction=user_instruction,
    )

    user_prompt = GHOSTWRITE_USER.format(
        recent_messages=recent_formatted,
        user_name=user_name,
        user_instruction=f"\n\n{priority_brief}{instruction_block}",
    )

    # Generate with Claude
    logger.info("[RESPOND] Calling Claude for response generation...")
    suggested_text = await generate_response(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=512,
        temperature=0.7,
        user_id=user_id,
        operation="ghostwrite",
        model=model,
        user_settings=user_settings,
    )

    # Store suggestion
    cleaned_suggestion = _normalize_suggested_text(suggested_text)

    suggestion = ResponseSuggestion(
        user_id=user_id,
        contact_id=contact_id,
        suggested_response=cleaned_suggestion,
        context_used=f"Used {len(context['conversation_chunks'])} conversation chunks, "
        f"{len(context['document_chunks'])} document chunks, "
        "query-expanded + recency-reranked",
        status="pending",
    )
    db.add(suggestion)
    await db.commit()
    await db.refresh(suggestion)

    logger.info(
        f"[RESPOND] Suggestion {suggestion.id} created for {contact.display_name}"
    )
    return suggestion


async def query_chat_history(
    db: AsyncSession,
    user_id: uuid.UUID,
    question: str,
    user_name: str,
    contact_id: uuid.UUID | None = None,
    scope_type: str = "all",
    contact_ids: list[uuid.UUID] | None = None,
    model: str | None = None,
    user_settings: dict | None = None,
) -> dict:
    """
    Answer a natural language question about chat history using RAG.

    Returns:
        {"answer": str, "sources": list[dict]}
    """
    logger.info(f"[QUERY] Question: '{question[:80]}...', contact_id={contact_id}")

    # Retrieve relevant context
    context = await retrieve_relevant_chunks(
        db,
        user_id,
        question,
        contact_id=contact_id,
        scope_type=scope_type,
        contact_ids=contact_ids,
        top_k=12,
        user_settings=user_settings,
    )

    conv_context = format_context_chunks(context["conversation_chunks"])
    doc_context = format_context_chunks(context["document_chunks"], is_doc=True)

    system_prompt = QUERY_SYSTEM.format(user_name=user_name)
    user_prompt = QUERY_USER.format(
        retrieved_context=conv_context or "No relevant conversations found.",
        document_context=doc_context or "No relevant documents found.",
        question=question,
    )

    logger.info("[QUERY] Calling Claude for answer generation...")
    answer = await generate_response(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        temperature=0.3,  # Lower temp for factual answers
        user_id=user_id,
        operation="query",
        model=model,
        user_settings=user_settings,
    )

    # Build source citations
    sources = []
    for chunk in context["conversation_chunks"][:5]:
        sources.append(
            {
                "contact_name": chunk["contact_name"],
                "document_name": None,
                "text_preview": chunk["text"][:200],
                "timestamp": chunk.get("session_start"),
                "relevance_score": chunk["score"],
            }
        )
    for chunk in context["document_chunks"][:3]:
        sources.append(
            {
                "contact_name": None,
                "document_name": chunk["document_name"],
                "text_preview": chunk["text"][:200],
                "timestamp": None,
                "relevance_score": chunk["score"],
            }
        )

    return {"answer": answer, "sources": sources}


def format_messages(messages: list[Message]) -> str:
    """Format message list for prompt inclusion."""
    lines = []
    for msg in messages:
        ts = msg.sent_at.strftime("%Y-%m-%d %H:%M")
        lines.append(f"[{ts}] {msg.sender_name}: {msg.content}")
    return "\n".join(lines)


def format_context_chunks(chunks: list[dict], is_doc: bool = False) -> str:
    """Format retrieved chunks for prompt inclusion."""
    if not chunks:
        return ""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        if is_doc:
            header = f"[Document: {chunk.get('document_name', 'Unknown')}]"
        else:
            header = f"[Conversation with {chunk.get('contact_name', 'Unknown')}"
            if chunk.get("session_start"):
                header += f", {chunk['session_start'][:10]}"
            header += "]"
        parts.append(f"{header}\n{chunk['text']}")
    return "\n\n---\n\n".join(parts)
