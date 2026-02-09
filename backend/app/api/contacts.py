"""Contact management routes."""

import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from app.database import get_db
from app.api.deps import get_current_user, get_user_llm_model
from app.models.user import User
from app.models.contact import Contact
from app.models.message import Message
from app.services.llm import generate_response
from app.schemas.contact import (
    ContactResponse,
    ContactListResponse,
    ContactSettingsUpdate,
    MessageResponse,
    MessageListResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/contacts", tags=["contacts"])


@router.get("", response_model=ContactListResponse)
async def list_contacts(
    search: str | None = Query(None),
    sort: str = Query("last_message_at"),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all contacts with optional search."""
    stmt = select(Contact).where(Contact.user_id == user.id)

    if search:
        stmt = stmt.where(
            Contact.display_name.ilike(f"%{search}%")
            | Contact.username.ilike(f"%{search}%")
        )

    # Count
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    # Sort
    if sort == "unresponded":
        stmt = stmt.order_by(desc(Contact.unresponded_count), desc(Contact.last_message_at))
    elif sort == "name":
        stmt = stmt.order_by(Contact.display_name)
    else:
        stmt = stmt.order_by(desc(Contact.last_message_at))

    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    contacts = result.scalars().all()

    return ContactListResponse(
        contacts=[
            ContactResponse(
                id=str(c.id),
                telegram_id=c.telegram_id,
                display_name=c.display_name,
                username=c.username,
                chat_type=c.chat_type,
                style_profile=c.style_profile,
                auto_respond=c.auto_respond,
                last_message_at=c.last_message_at,
                unresponded_count=c.unresponded_count,
                total_messages=c.total_messages,
                created_at=c.created_at,
            )
            for c in contacts
        ],
        total=total,
    )


@router.get("/{contact_id}", response_model=ContactResponse)
async def get_contact(
    contact_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get a single contact's details."""
    contact = await db.get(Contact, uuid.UUID(contact_id))
    if not contact or contact.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")

    return ContactResponse(
        id=str(contact.id),
        telegram_id=contact.telegram_id,
        display_name=contact.display_name,
        username=contact.username,
        chat_type=contact.chat_type,
        style_profile=contact.style_profile,
        auto_respond=contact.auto_respond,
        last_message_at=contact.last_message_at,
        unresponded_count=contact.unresponded_count,
        total_messages=contact.total_messages,
        created_at=contact.created_at,
    )


@router.patch("/{contact_id}/settings", response_model=ContactResponse)
async def update_contact_settings(
    contact_id: str,
    update: ContactSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update contact settings (auto-respond, display name)."""
    contact = await db.get(Contact, uuid.UUID(contact_id))
    if not contact or contact.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")

    if update.auto_respond is not None:
        contact.auto_respond = update.auto_respond
    if update.display_name is not None:
        contact.display_name = update.display_name

    await db.commit()
    await db.refresh(contact)
    logger.info(f"[CONTACTS] Updated settings for {contact.display_name}")

    return ContactResponse(
        id=str(contact.id),
        telegram_id=contact.telegram_id,
        display_name=contact.display_name,
        username=contact.username,
        chat_type=contact.chat_type,
        style_profile=contact.style_profile,
        auto_respond=contact.auto_respond,
        last_message_at=contact.last_message_at,
        unresponded_count=contact.unresponded_count,
        total_messages=contact.total_messages,
        created_at=contact.created_at,
    )


@router.get("/{contact_id}/messages", response_model=MessageListResponse)
async def get_contact_messages(
    contact_id: str,
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get paginated messages for a contact."""
    contact = await db.get(Contact, uuid.UUID(contact_id))
    if not contact or contact.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")

    # Count
    count_stmt = (
        select(func.count())
        .select_from(Message)
        .where(Message.contact_id == contact.id)
    )
    total = (await db.execute(count_stmt)).scalar() or 0

    # Fetch messages (newest first for pagination, reversed for display)
    stmt = (
        select(Message)
        .where(Message.contact_id == contact.id)
        .order_by(desc(Message.sent_at))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    messages = list(reversed(result.scalars().all()))

    return MessageListResponse(
        messages=[
            MessageResponse(
                id=str(m.id),
                sender_type=m.sender_type,
                sender_name=m.sender_name,
                content=m.content,
                sent_at=m.sent_at,
                is_read=m.is_read,
                is_responded=m.is_responded,
            )
            for m in messages
        ],
        total=total,
        contact=ContactResponse(
            id=str(contact.id),
            telegram_id=contact.telegram_id,
            display_name=contact.display_name,
            username=contact.username,
            chat_type=contact.chat_type,
            style_profile=contact.style_profile,
            auto_respond=contact.auto_respond,
            last_message_at=contact.last_message_at,
            unresponded_count=contact.unresponded_count,
            total_messages=contact.total_messages,
            created_at=contact.created_at,
        ),
    )


SUMMARY_SYSTEM = """You are a concise conversation analyst. You are summarizing a chat for the user ("You") so they can quickly get up to speed before replying.

Rules:
- 4-6 bullet points max
- REVERSE CHRONOLOGICAL ORDER: most recent topics first, older topics last
- ALWAYS refer to the user as "You" (never by their name)
- Refer to the other person by their name
- Start with any ACTION ITEMS or things that need your immediate attention/reply — prefix these with ⚡
- Then cover recent discussion topics in order of recency
- Use present tense ("They're asking you about...", "You discussed...")
- Keep each bullet to one line
- No preamble, just the bullets"""


@router.get("/{contact_id}/summary")
async def get_contact_summary(
    contact_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a quick summary of recent conversation context."""
    contact = await db.get(Contact, uuid.UUID(contact_id))
    if not contact or contact.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")

    # Fetch last 30 messages for context
    stmt = (
        select(Message)
        .where(Message.contact_id == contact.id)
        .order_by(desc(Message.sent_at))
        .limit(30)
    )
    result = await db.execute(stmt)
    messages = list(reversed(result.scalars().all()))

    if not messages:
        return {"summary": "No messages yet."}

    # Build chat transcript — use "You" for self messages
    lines = []
    for m in messages:
        name = "You" if m.sender_type == "self" else contact.display_name
        lines.append(f"{name}: {m.content}")
    transcript = "\n".join(lines)

    summary = await generate_response(
        system_prompt=SUMMARY_SYSTEM,
        user_prompt=f"Summarize this conversation between You and {contact.display_name}:\n\n{transcript}",
        max_tokens=300,
        temperature=0.3,
        user_id=user.id,
        operation="chat_summary",
        model=get_user_llm_model(user),
    )

    return {"summary": summary, "message_count": len(messages)}
