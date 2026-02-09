"""
Full RAG pipeline for generating ghostwritten responses.

Orchestrates: retrieval → prompt building → Claude generation
"""

import logging
import uuid
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


async def generate_reply(
    db: AsyncSession,
    user_id: uuid.UUID,
    contact_id: uuid.UUID,
    user_name: str,
    user_instruction: str | None = None,
    model: str | None = None,
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

    query_text = last_incoming.content if last_incoming else recent_msgs[-1].content

    # Retrieve relevant context
    logger.info("[RESPOND] Retrieving relevant context...")
    context = await retrieve_relevant_chunks(
        db, user_id, query_text, contact_id=contact_id, top_k=8
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

    user_prompt = GHOSTWRITE_USER.format(
        recent_messages=recent_formatted,
        user_name=user_name,
        user_instruction=instruction_block,
    )

    # Generate with Claude
    logger.info("[RESPOND] Calling Claude for response generation...")
    suggested_text = await generate_response(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        temperature=0.7,
        user_id=user_id,
        operation="ghostwrite",
        model=model,
    )

    # Store suggestion
    suggestion = ResponseSuggestion(
        user_id=user_id,
        contact_id=contact_id,
        suggested_response=suggested_text.strip(),
        context_used=f"Used {len(context['conversation_chunks'])} conversation chunks, "
        f"{len(context['document_chunks'])} document chunks",
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
    model: str | None = None,
) -> dict:
    """
    Answer a natural language question about chat history using RAG.

    Returns:
        {"answer": str, "sources": list[dict]}
    """
    logger.info(f"[QUERY] Question: '{question[:80]}...', contact_id={contact_id}")

    # Retrieve relevant context
    context = await retrieve_relevant_chunks(
        db, user_id, question, contact_id=contact_id, top_k=12
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
