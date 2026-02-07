"""Chat query route — natural language questions about chat history."""

import logging
import uuid
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.chat import QueryRequest, QueryResponse, SourceChunk
from app.services.response_generator import query_chat_history

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])


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
