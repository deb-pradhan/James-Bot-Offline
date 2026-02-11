"""Dashboard routes — overview stats, critical actions, activity summary, cost tracking."""

import logging
import json
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc, cast, Date, or_
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis, get_user_llm_model, get_user_settings
from app.models.user import User
from app.models.contact import Contact
from app.models.message import Message
from app.models.document import Document
from app.models.chunk import ConversationChunk, DocumentChunk
from app.models.suggestion import ResponseSuggestion
from app.models.api_usage import ApiUsage
from app.services.llm import generate_response
from app.schemas.dashboard import (
    DashboardOverview,
    UnrespondedContact,
    UnrespondedListResponse,
    CriticalAction,
    CriticalActionsResponse,
    ActivitySummaryResponse,
    ScopeOption,
    ScopeOptionsResponse,
    ScopeUpdate,
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


# ── Scope helpers ────────────────────────────────────────────────

def _get_dashboard_scope(user: User) -> tuple[str, list[str]]:
    """Return (scope_type, contact_ids) from user settings."""
    s = user.settings or {}
    scope_type = s.get("dashboard_scope_type", "all")
    contact_ids = s.get("dashboard_scope_contacts", [])
    return scope_type, contact_ids


def _apply_scope_filter(stmt, user: User, scope_type: str, contact_ids: list[str]):
    """Apply dashboard scope to a Contact-based query."""
    import uuid as _uuid
    if scope_type == "dms":
        stmt = stmt.where(Contact.chat_type == "personal_chat")
    elif scope_type == "groups":
        stmt = stmt.where(Contact.chat_type.in_(["group", "supergroup", "channel"]))
    elif scope_type == "custom" and contact_ids:
        stmt = stmt.where(Contact.id.in_([_uuid.UUID(cid) for cid in contact_ids]))
    return stmt


def _scope_label(scope_type: str) -> str:
    return {"all": "All Chats", "dms": "DMs Only", "groups": "Groups Only", "custom": "Watched Chats"}.get(scope_type, scope_type)


# ── Critical Actions ─────────────────────────────────────────────


@router.get("/critical-actions", response_model=CriticalActionsResponse)
async def get_critical_actions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get contacts that need urgent attention, scored by urgency."""
    logger.info(f"[DASHBOARD] Critical actions for {user.email}")

    scope_type, contact_ids = _get_dashboard_scope(user)

    # All contacts with unresponded messages
    stmt = (
        select(Contact)
        .where(Contact.user_id == user.id, Contact.unresponded_count > 0)
    )
    stmt = _apply_scope_filter(stmt, user, scope_type, contact_ids)
    result = await db.execute(stmt)
    contacts = result.scalars().all()

    now = datetime.utcnow()
    actions = []

    for c in contacts:
        # Get last message preview
        last_msg_stmt = (
            select(Message)
            .where(Message.contact_id == c.id, Message.sender_type == "other")
            .order_by(desc(Message.sent_at))
            .limit(1)
        )
        last_msg = (await db.execute(last_msg_stmt)).scalar_one_or_none()

        # Pending suggestion
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

        # Calculate urgency score
        hours_waiting = 0.0
        if c.last_message_at:
            hours_waiting = (now - c.last_message_at).total_seconds() / 3600

        # Score components (higher = more urgent)
        time_score = min(hours_waiting / 2, 50)  # Max 50 pts, escalates over 100h
        count_score = min(c.unresponded_count * 5, 25)  # Max 25 pts
        type_score = 15 if c.chat_type == "personal_chat" else 5  # DMs are more urgent
        content_score = 0
        preview = last_msg.content[:200] if last_msg else ""
        if preview:
            if "?" in preview:
                content_score += 10  # Question asked
            urgent_words = ["urgent", "asap", "important", "help", "please reply", "waiting"]
            if any(w in preview.lower() for w in urgent_words):
                content_score += 15

        urgency_score = time_score + count_score + type_score + content_score

        # Determine urgency level
        if urgency_score >= 50:
            urgency = "critical"
        elif urgency_score >= 25:
            urgency = "high"
        else:
            urgency = "medium"

        # Build reason string
        reasons = []
        if hours_waiting >= 24:
            reasons.append(f"Waiting {int(hours_waiting)}h")
        elif hours_waiting >= 1:
            reasons.append(f"Waiting {hours_waiting:.0f}h")
        if c.unresponded_count > 1:
            reasons.append(f"{c.unresponded_count} messages")
        if content_score >= 15:
            reasons.append("Urgent keywords")
        elif content_score >= 10:
            reasons.append("Question asked")
        if c.chat_type == "personal_chat":
            reasons.append("DM")
        reason = " · ".join(reasons) if reasons else "Needs response"

        actions.append(CriticalAction(
            contact_id=str(c.id),
            display_name=c.display_name,
            username=c.username,
            chat_type=c.chat_type,
            urgency=urgency,
            urgency_score=round(urgency_score, 1),
            reason=reason,
            unresponded_count=c.unresponded_count,
            hours_waiting=round(hours_waiting, 1),
            last_message_at=c.last_message_at,
            last_message_preview=preview[:100] if preview else None,
            has_pending_suggestion=suggestion is not None,
            pending_suggestion_id=str(suggestion.id) if suggestion else None,
            pending_suggestion_text=suggestion.suggested_response if suggestion else None,
        ))

    # Sort by last message time descending (most recent first)
    actions.sort(key=lambda a: a.last_message_at or datetime.min, reverse=True)

    return CriticalActionsResponse(
        actions=actions,
        total=len(actions),
        scope=_scope_label(scope_type),
    )


# ── Activity Summary ─────────────────────────────────────────────

BRIEFING_SYSTEM = """You are a concise executive briefing assistant. The user is reviewing their Telegram messages after being away.

Generate a well-structured briefing in markdown. Use this exact structure:

## ⚡ Action Required
- List items that need the user's immediate response or action
- Be specific: who needs what, and context for why it's urgent
- If nothing urgent, write "Nothing urgent right now."

## 📋 Key Conversations
- Summarize the most important/active threads
- Mention who said what, key topics, decisions made
- Group by contact/chat where it makes sense

## 📌 Notable
- Anything interesting but not urgent: announcements, FYIs, links shared
- Skip this section entirely if there's nothing notable

Rules:
- ALWAYS refer to the user as "You" (never by their name)
- Refer to others by their display name
- Be concise — one line per bullet, max 2 lines for complex items
- Use **bold** for contact names and key terms
- Include message counts per contact if helpful (e.g. "**Alice** (4 messages): ...")
- If there are too many chats, focus on the top 10-15 most active/important
- No preamble or closing remarks, just the briefing"""


@router.get("/activity-summary", response_model=ActivitySummaryResponse)
async def get_activity_summary(
    force: bool = Query(False, description="Force regenerate even if cached"),
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Generate an AI-powered activity summary since last visit."""
    logger.info(f"[DASHBOARD] Activity summary for {user.email}, force={force}")

    scope_type, contact_ids = _get_dashboard_scope(user)
    user_settings = user.settings or {}

    # Determine "since" — last dashboard visit or 24h ago
    last_visit_str = user_settings.get("last_dashboard_visit")
    if last_visit_str:
        try:
            since = datetime.fromisoformat(last_visit_str)
        except (ValueError, TypeError):
            since = datetime.utcnow() - timedelta(hours=24)
    else:
        since = datetime.utcnow() - timedelta(hours=24)

    # Cap at 72h to avoid massive context
    min_since = datetime.utcnow() - timedelta(hours=72)
    if since < min_since:
        since = min_since

    # Check cache (keyed by user + scope + since timestamp, TTL 5 min)
    cache_key = f"dashboard:briefing:{user.id}:{scope_type}:{since.isoformat()}"
    if not force:
        cached = await redis_client.get(cache_key)
        if cached:
            cached_data = json.loads(cached)
            return ActivitySummaryResponse(
                summary=cached_data["summary"],
                since=since,
                contacts_active=cached_data["contacts_active"],
                messages_count=cached_data["messages_count"],
                scope=_scope_label(scope_type),
                cached=True,
            )

    # Fetch contacts in scope
    contacts_stmt = select(Contact).where(Contact.user_id == user.id)
    contacts_stmt = _apply_scope_filter(contacts_stmt, user, scope_type, contact_ids)
    contacts_result = await db.execute(contacts_stmt)
    contacts = {c.id: c for c in contacts_result.scalars().all()}

    if not contacts:
        return ActivitySummaryResponse(
            summary="No chats in the selected scope.",
            since=since,
            contacts_active=0,
            messages_count=0,
            scope=_scope_label(scope_type),
        )

    # Fetch messages since last visit for scoped contacts
    msg_stmt = (
        select(Message)
        .where(
            Message.contact_id.in_(list(contacts.keys())),
            Message.sent_at > since,
        )
        .order_by(Message.sent_at)
    )
    msg_result = await db.execute(msg_stmt)
    messages = msg_result.scalars().all()

    if not messages:
        # Record the visit even if no messages
        summary_text = "No new messages since your last visit."
        return ActivitySummaryResponse(
            summary=summary_text,
            since=since,
            contacts_active=0,
            messages_count=0,
            scope=_scope_label(scope_type),
        )

    # Group messages by contact for the transcript
    from collections import defaultdict
    by_contact: dict[str, list] = defaultdict(list)
    for m in messages:
        by_contact[m.contact_id].append(m)

    # Build a structured transcript for Claude
    transcript_parts = []
    for cid, msgs in by_contact.items():
        contact = contacts.get(cid)
        if not contact:
            continue
        chat_label = contact.display_name
        if contact.chat_type in ("group", "supergroup"):
            chat_label = f"[Group] {contact.display_name}"
        elif contact.chat_type == "channel":
            chat_label = f"[Channel] {contact.display_name}"

        transcript_parts.append(f"\n--- {chat_label} ({len(msgs)} messages) ---")
        for m in msgs[-30:]:  # Last 30 per contact to keep context reasonable
            name = "You" if m.sender_type == "self" else m.sender_name
            time_str = m.sent_at.strftime("%b %d %H:%M")
            transcript_parts.append(f"[{time_str}] {name}: {m.content[:300]}")

    transcript = "\n".join(transcript_parts)

    # Truncate to ~12k chars to stay within context limits
    if len(transcript) > 12000:
        transcript = transcript[:12000] + "\n\n[... truncated for brevity ...]"

    contacts_active = len(by_contact)
    messages_count = len(messages)

    summary_text = await generate_response(
        system_prompt=BRIEFING_SYSTEM,
        user_prompt=f"Briefing since {since.strftime('%B %d, %H:%M UTC')}. {messages_count} messages across {contacts_active} chats:\n\n{transcript}",
        max_tokens=800,
        temperature=0.3,
        user_id=user.id,
        operation="activity_briefing",
        model=get_user_llm_model(user),
        user_settings=get_user_settings(user),
    )

    # Cache for 5 minutes
    await redis_client.setex(
        cache_key,
        300,
        json.dumps({
            "summary": summary_text,
            "contacts_active": contacts_active,
            "messages_count": messages_count,
        }),
    )

    return ActivitySummaryResponse(
        summary=summary_text,
        since=since,
        contacts_active=contacts_active,
        messages_count=messages_count,
        scope=_scope_label(scope_type),
    )


# ── Scope Management ─────────────────────────────────────────────


@router.get("/scope-options", response_model=ScopeOptionsResponse)
async def get_scope_options(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get available contacts for dashboard scoping."""
    stmt = (
        select(Contact)
        .where(Contact.user_id == user.id)
        .order_by(desc(Contact.total_messages))
    )
    result = await db.execute(stmt)
    contacts = result.scalars().all()

    return ScopeOptionsResponse(
        contacts=[
            ScopeOption(
                id=str(c.id),
                label=c.display_name,
                chat_type=c.chat_type,
                message_count=c.total_messages,
            )
            for c in contacts
        ]
    )


@router.put("/scope")
async def update_scope(
    body: ScopeUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update dashboard scope preferences."""
    settings = dict(user.settings or {})
    settings["dashboard_scope_type"] = body.scope_type
    settings["dashboard_scope_contacts"] = body.contact_ids
    user.settings = settings
    await db.commit()
    return {"status": "ok", "scope_type": body.scope_type}


@router.post("/mark-visited")
async def mark_visited(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Record that the user visited the dashboard (updates last_dashboard_visit)."""
    settings = dict(user.settings or {})
    settings["last_dashboard_visit"] = datetime.utcnow().isoformat()
    user.settings = settings
    await db.commit()
    return {"status": "ok"}


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
    # Ensure we cover the full range of the last 30 days starting from midnight
    start_date = (now - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
    
    daily_rows = (
        await db.execute(
            select(
                cast(ApiUsage.created_at, Date).label("day"),
                func.sum(ApiUsage.cost_usd),
                func.count(),
            )
            .where(base_filter, ApiUsage.created_at >= start_date)
            .group_by("day")
            .order_by("day")
        )
    ).all()

    # Fill in missing days
    daily_data_map = {str(row[0]): row for row in daily_rows}
    daily_costs = []

    for i in range(30):
        # Generate date for (start_date + i days)
        # i=0 -> start_date (29 days ago)
        # i=29 -> start_date + 29 days (today)
        d = (start_date + timedelta(days=i)).date()
        d_str = str(d)

        if d_str in daily_data_map:
            row = daily_data_map[d_str]
            daily_costs.append(DailyCost(
                date=d_str,
                cost_usd=round(float(row[1]), 6),
                api_calls=int(row[2]),
            ))
        else:
            daily_costs.append(DailyCost(
                date=d_str,
                cost_usd=0.0,
                api_calls=0,
            ))

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
