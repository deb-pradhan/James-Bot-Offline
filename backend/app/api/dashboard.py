"""Dashboard routes — overview stats, unresponded contacts, cost tracking."""

import logging
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc, cast, Date
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis
from app.models.user import User
from app.models.contact import Contact
from app.models.message import Message
from app.models.document import Document
from app.models.chunk import ConversationChunk, DocumentChunk
from app.models.suggestion import ResponseSuggestion
from app.models.api_usage import ApiUsage
from app.schemas.dashboard import (
    DashboardOverview,
    UnrespondedContact,
    UnrespondedListResponse,
    CostSummary,
    ServiceCost,
    OperationCost,
    DailyCost,
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

        # Fetch the actual pending suggestion (most recent)
        suggestion_stmt = (
            select(ResponseSuggestion)
            .where(
                ResponseSuggestion.contact_id == c.id,
                ResponseSuggestion.status == "pending",
            )
            .order_by(desc(ResponseSuggestion.created_at))
            .limit(1)
        )
        suggestion = (await db.execute(suggestion_stmt)).scalar_one_or_none()

        items.append(
            UnrespondedContact(
                contact_id=str(c.id),
                display_name=c.display_name,
                username=c.username,
                unresponded_count=c.unresponded_count,
                last_message_at=c.last_message_at,
                last_message_preview=last_msg.content[:100] if last_msg else None,
                has_pending_suggestion=suggestion is not None,
                pending_suggestion_id=str(suggestion.id) if suggestion else None,
                pending_suggestion_text=suggestion.suggested_response if suggestion else None,
            )
        )

    return UnrespondedListResponse(contacts=items, total=len(items))


@router.get("/costs", response_model=CostSummary)
async def get_costs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get aggregated cost/usage stats for the current user."""
    logger.info(f"[DASHBOARD] Costs for {user.email}")

    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    thirty_days_ago = now - timedelta(days=30)

    base_filter = ApiUsage.user_id == user.id

    # ── Total cost ──
    total_cost = (
        await db.execute(
            select(func.coalesce(func.sum(ApiUsage.cost_usd), 0.0)).where(base_filter)
        )
    ).scalar()

    # ── Today's cost ──
    today_cost = (
        await db.execute(
            select(func.coalesce(func.sum(ApiUsage.cost_usd), 0.0)).where(
                base_filter, ApiUsage.created_at >= today_start
            )
        )
    ).scalar()

    # ── This month's cost ──
    month_cost = (
        await db.execute(
            select(func.coalesce(func.sum(ApiUsage.cost_usd), 0.0)).where(
                base_filter, ApiUsage.created_at >= month_start
            )
        )
    ).scalar()

    # ── Total API calls ──
    total_calls = (
        await db.execute(
            select(func.count()).select_from(ApiUsage).where(base_filter)
        )
    ).scalar() or 0

    # ── Token totals: LLM (anthropic) vs embedding ──
    llm_tokens = (
        await db.execute(
            select(
                func.coalesce(func.sum(ApiUsage.input_tokens), 0),
                func.coalesce(func.sum(ApiUsage.output_tokens), 0),
            ).where(base_filter, ApiUsage.service == "anthropic")
        )
    ).one()
    total_llm_in, total_llm_out = int(llm_tokens[0]), int(llm_tokens[1])

    embed_tokens = (
        await db.execute(
            select(func.coalesce(func.sum(ApiUsage.input_tokens), 0)).where(
                base_filter, ApiUsage.service != "anthropic"
            )
        )
    ).scalar()
    total_embed = int(embed_tokens)

    # ── Breakdown by service ──
    service_rows = (
        await db.execute(
            select(
                ApiUsage.service,
                func.sum(ApiUsage.cost_usd),
                func.sum(ApiUsage.input_tokens),
                func.sum(ApiUsage.output_tokens),
                func.count(),
            )
            .where(base_filter)
            .group_by(ApiUsage.service)
        )
    ).all()

    by_service = [
        ServiceCost(
            service=row[0],
            cost_usd=round(float(row[1]), 6),
            total_input_tokens=int(row[2]),
            total_output_tokens=int(row[3]),
            api_calls=int(row[4]),
        )
        for row in service_rows
    ]

    # ── Breakdown by operation ──
    op_rows = (
        await db.execute(
            select(
                ApiUsage.operation,
                func.sum(ApiUsage.cost_usd),
                func.count(),
            )
            .where(base_filter)
            .group_by(ApiUsage.operation)
        )
    ).all()

    by_operation = [
        OperationCost(
            operation=row[0],
            cost_usd=round(float(row[1]), 6),
            api_calls=int(row[2]),
        )
        for row in op_rows
    ]

    # ── Daily costs (last 30 days) ──
    daily_rows = (
        await db.execute(
            select(
                cast(ApiUsage.created_at, Date).label("day"),
                func.sum(ApiUsage.cost_usd),
                func.count(),
            )
            .where(base_filter, ApiUsage.created_at >= thirty_days_ago)
            .group_by("day")
            .order_by("day")
        )
    ).all()

    daily_costs = [
        DailyCost(
            date=str(row[0]),
            cost_usd=round(float(row[1]), 6),
            api_calls=int(row[2]),
        )
        for row in daily_rows
    ]

    return CostSummary(
        total_cost_usd=round(float(total_cost), 6),
        today_cost_usd=round(float(today_cost), 6),
        month_cost_usd=round(float(month_cost), 6),
        total_llm_tokens_in=total_llm_in,
        total_llm_tokens_out=total_llm_out,
        total_embedding_tokens=total_embed,
        total_api_calls=total_calls,
        by_service=by_service,
        by_operation=by_operation,
        daily_costs=daily_costs,
    )
