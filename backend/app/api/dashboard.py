"""Dashboard routes — overview stats, unresponded contacts."""

import logging
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis
from app.models.user import User
from app.models.contact import Contact
from app.models.message import Message
from app.models.document import Document
from app.models.chunk import ConversationChunk, DocumentChunk
from app.models.suggestion import ResponseSuggestion
from app.schemas.dashboard import (
    DashboardOverview,
    UnrespondedContact,
    UnrespondedListResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/overview", response_model=DashboardOverview)
async def get_overview(
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Get dashboard overview stats."""
    logger.info(f"[DASHBOARD] Overview for {user.email}")

    # Total contacts
    total_contacts = (
        await db.execute(
            select(func.count()).select_from(Contact).where(Contact.user_id == user.id)
        )
    ).scalar() or 0

    # Total messages
    total_messages = (
        await db.execute(
            select(func.count())
            .select_from(Message)
            .join(Contact)
            .where(Contact.user_id == user.id)
        )
    ).scalar() or 0

    # Total documents
    total_documents = (
        await db.execute(
            select(func.count()).select_from(Document).where(Document.user_id == user.id)
        )
    ).scalar() or 0

    # Total chunks (conversation + document)
    conv_chunks = (
        await db.execute(
            select(func.count())
            .select_from(ConversationChunk)
            .join(Contact)
            .where(Contact.user_id == user.id)
        )
    ).scalar() or 0

    doc_chunks = (
        await db.execute(
            select(func.count())
            .select_from(DocumentChunk)
            .join(Document)
            .where(Document.user_id == user.id)
        )
    ).scalar() or 0

    # Unresponded count
    unresponded = (
        await db.execute(
            select(func.sum(Contact.unresponded_count)).where(
                Contact.user_id == user.id
            )
        )
    ).scalar() or 0

    # Pending suggestions
    pending = (
        await db.execute(
            select(func.count())
            .select_from(ResponseSuggestion)
            .where(
                ResponseSuggestion.user_id == user.id,
                ResponseSuggestion.status == "pending",
            )
        )
    ).scalar() or 0

    # Check Telegram connection via Redis
    tg_status = await redis_client.get(f"telegram:connected:{str(user.id)}")
    telegram_connected = tg_status == "true"

    return DashboardOverview(
        total_contacts=total_contacts,
        total_messages=total_messages,
        total_documents=total_documents,
        total_chunks=conv_chunks + doc_chunks,
        unresponded_count=unresponded,
        pending_suggestions=pending,
        telegram_connected=telegram_connected,
    )


@router.get("/unresponded", response_model=UnrespondedListResponse)
async def get_unresponded(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get all contacts with unresponded messages, sorted by staleness."""
    logger.info(f"[DASHBOARD] Unresponded contacts for {user.email}")

    stmt = (
        select(Contact)
        .where(Contact.user_id == user.id, Contact.unresponded_count > 0)
        .order_by(desc(Contact.unresponded_count), Contact.last_message_at)
    )
    result = await db.execute(stmt)
    contacts = result.scalars().all()

    items = []
    for c in contacts:
        # Get last message preview
        last_msg_stmt = (
            select(Message)
            .where(Message.contact_id == c.id, Message.sender_type == "other")
            .order_by(desc(Message.sent_at))
            .limit(1)
        )
        last_msg = (await db.execute(last_msg_stmt)).scalar_one_or_none()

        # Check for pending suggestions
        suggestion_stmt = (
            select(func.count())
            .select_from(ResponseSuggestion)
            .where(
                ResponseSuggestion.contact_id == c.id,
                ResponseSuggestion.status == "pending",
            )
        )
        has_suggestion = ((await db.execute(suggestion_stmt)).scalar() or 0) > 0

        items.append(
            UnrespondedContact(
                contact_id=str(c.id),
                display_name=c.display_name,
                username=c.username,
                unresponded_count=c.unresponded_count,
                last_message_at=c.last_message_at,
                last_message_preview=last_msg.content[:100] if last_msg else None,
                has_pending_suggestion=has_suggestion,
            )
        )

    return UnrespondedListResponse(contacts=items, total=len(items))
