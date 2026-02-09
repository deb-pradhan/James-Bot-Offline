"""Chat query route — natural language questions about chat history."""

import logging
import random
import uuid
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from app.database import get_db
from app.api.deps import get_current_user, get_user_llm_model
from app.models.user import User
from app.models.contact import Contact
from app.models.document import Document
from app.schemas.chat import (
    QueryRequest,
    QueryResponse,
    SourceChunk,
    ChatSuggestionsResponse,
)
from app.services.response_generator import query_chat_history

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])

DEFAULT_SUGGESTIONS = [
    "What did I discuss with partner X last month?",
    "Summarize my conversations from this week",
    "When did we talk about the contract?",
    "Which contacts haven't I responded to?",
]


@router.get("/suggestions", response_model=ChatSuggestionsResponse)
async def get_chat_suggestions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Return personalized query suggestions based on ingested contacts/documents.
    Falls back to generic defaults when no data is ingested yet.
    """
    # Fetch top contacts by recent activity
    contacts_stmt = (
        select(Contact.display_name, Contact.unresponded_count)
        .where(Contact.user_id == user.id)
        .order_by(desc(Contact.last_message_at))
        .limit(10)
    )
    contacts_result = await db.execute(contacts_stmt)
    contacts = contacts_result.all()

    # Fetch documents
    docs_stmt = (
        select(Document.filename, Document.scope)
        .where(Document.user_id == user.id)
        .order_by(desc(Document.uploaded_at))
        .limit(5)
    )
    docs_result = await db.execute(docs_stmt)
    documents = docs_result.all()

    # No data yet — return defaults
    if not contacts and not documents:
        return ChatSuggestionsResponse(
            suggestions=DEFAULT_SUGGESTIONS,
            personalized=False,
        )

    # ── Build personalized suggestions ──
    suggestions: list[str] = []

    if contacts:
        contact_names = [c.display_name for c in contacts]

        # Pick up to 2 random contacts for name-specific prompts
        sampled = random.sample(contact_names, min(2, len(contact_names)))

        templates_with_name = [
            "Summarize my recent conversations with {name}",
            "What did {name} and I last talk about?",
            "What topics come up most with {name}?",
            "When did {name} last message me?",
            "What's the overall tone of my chats with {name}?",
        ]

        for name in sampled:
            t = random.choice(templates_with_name)
            suggestions.append(t.format(name=name))

        # Unresponded-specific
        unresponded = [c for c in contacts if c.unresponded_count > 0]
        if unresponded:
            if len(unresponded) == 1:
                suggestions.append(
                    f"What did {unresponded[0].display_name} say that I haven't replied to?"
                )
            else:
                suggestions.append("Which contacts am I behind on responding to?")

        # General cross-contact
        if len(contact_names) >= 3:
            suggestions.append("Summarize my conversations from this week")

    if documents:
        doc_names = [d.filename for d in documents]
        doc = random.choice(doc_names)
        # Strip extension for nicer display
        short = doc.rsplit(".", 1)[0] if "." in doc else doc
        suggestions.append(f"What are the key points from '{short}'?")

        if len(documents) > 1:
            suggestions.append("Search my uploaded documents for action items")

    # Ensure we return 4 suggestions (pad with generic if short)
    generic_pool = [
        "Summarize my most important conversations this month",
        "What recurring topics come up across all my chats?",
        "Find any mentions of deadlines or due dates",
        "What agreements or commitments have I made recently?",
    ]
    random.shuffle(generic_pool)
    while len(suggestions) < 4:
        suggestions.append(generic_pool.pop())

    # Cap at 4
    suggestions = suggestions[:4]

    return ChatSuggestionsResponse(
        suggestions=suggestions,
        personalized=True,
    )


@router.post("/query", response_model=QueryResponse)
async def query_history(
    req: QueryRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Ask a natural language question about your chat history.

    Examples:
    - "What did I discuss with partner X last month?"
    - "Summarize my relationship with Y"
    - "When did Z mention the contract?"
    """
    logger.info(f"[QUERY] User {user.email}: '{req.question[:80]}...'")

    contact_id = uuid.UUID(req.contact_id) if req.contact_id else None

    result = await query_chat_history(
        db=db,
        user_id=user.id,
        question=req.question,
        user_name=user.name,
        contact_id=contact_id,
        model=get_user_llm_model(user),
    )

    return QueryResponse(
        answer=result["answer"],
        sources=[
            SourceChunk(
                contact_name=s.get("contact_name"),
                document_name=s.get("document_name"),
                text_preview=s["text_preview"],
                timestamp=s.get("timestamp"),
                relevance_score=s["relevance_score"],
            )
            for s in result["sources"]
        ],
    )
