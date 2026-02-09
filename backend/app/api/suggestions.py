"""Suggestion routes — generate, list, approve, edit, reject, send."""

import logging
import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis, get_user_llm_model
from app.models.user import User
from app.models.contact import Contact
from app.models.suggestion import ResponseSuggestion
from app.schemas.suggestion import (
    SuggestionResponse,
    SuggestionListResponse,
    GenerateRequest,
    EditSuggestionRequest,
)
from app.services.response_generator import generate_reply

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/suggestions", tags=["suggestions"])


@router.get("", response_model=SuggestionListResponse)
async def list_suggestions(
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List suggestions, optionally filtered by status."""
    stmt = (
        select(ResponseSuggestion)
        .where(ResponseSuggestion.user_id == user.id)
        .order_by(desc(ResponseSuggestion.created_at))
    )

    if status:
        stmt = stmt.where(ResponseSuggestion.status == status)

    result = await db.execute(stmt)
    suggestions = result.scalars().all()

    items = []
    for s in suggestions:
        contact = await db.get(Contact, s.contact_id)
        items.append(
            SuggestionResponse(
                id=str(s.id),
                contact_id=str(s.contact_id),
                contact_name=contact.display_name if contact else None,
                suggested_response=s.suggested_response,
                context_used=s.context_used,
                status=s.status,
                created_at=s.created_at,
                sent_at=s.sent_at,
            )
        )

    return SuggestionListResponse(suggestions=items, total=len(items))


@router.post("/generate", response_model=SuggestionResponse)
async def generate_suggestion(
    req: GenerateRequest,
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Generate an AI response suggestion for a contact."""
    logger.info(f"[SUGGEST] Generate for contact {req.contact_id}")

    contact_id = uuid.UUID(req.contact_id)
    contact = await db.get(Contact, contact_id)
    if not contact or contact.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")

    # Publish status
    await redis_client.publish(
        f"user:{str(user.id)}:events",
        json.dumps(
            {
                "type": "processing_status",
                "message": f"Generating response for {contact.display_name}...",
            }
        ),
    )

    suggestion = await generate_reply(
        db=db,
        user_id=user.id,
        contact_id=contact_id,
        user_name=user.name,
        user_instruction=req.user_instruction,
        model=get_user_llm_model(user),
    )

    # Notify via WebSocket
    await redis_client.publish(
        f"user:{str(user.id)}:events",
        json.dumps(
            {
                "type": "suggestion_ready",
                "data": {
                    "suggestion_id": str(suggestion.id),
                    "contact_id": str(contact_id),
                    "contact_name": contact.display_name,
                },
                "message": f"Response ready for {contact.display_name}",
            }
        ),
    )

    return SuggestionResponse(
        id=str(suggestion.id),
        contact_id=str(suggestion.contact_id),
        contact_name=contact.display_name,
        suggested_response=suggestion.suggested_response,
        context_used=suggestion.context_used,
        status=suggestion.status,
        created_at=suggestion.created_at,
    )


@router.post("/generate-all", response_model=SuggestionListResponse)
async def generate_all_suggestions(
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Generate responses for ALL unresponded contacts."""
    logger.info(f"[SUGGEST] Generate-all for {user.email}")

    stmt = select(Contact).where(
        Contact.user_id == user.id, Contact.unresponded_count > 0
    )
    result = await db.execute(stmt)
    contacts = result.scalars().all()

    if not contacts:
        return SuggestionListResponse(suggestions=[], total=0)

    await redis_client.publish(
        f"user:{str(user.id)}:events",
        json.dumps(
            {
                "type": "processing_status",
                "message": f"Generating responses for {len(contacts)} contacts...",
            }
        ),
    )

    suggestions = []
    for i, contact in enumerate(contacts):
        try:
            await redis_client.publish(
                f"user:{str(user.id)}:events",
                json.dumps(
                    {
                        "type": "processing_status",
                        "message": f"Generating {i + 1}/{len(contacts)}: {contact.display_name}...",
                    }
                ),
            )

            suggestion = await generate_reply(
                db=db,
                user_id=user.id,
                contact_id=contact.id,
                user_name=user.name,
                model=get_user_llm_model(user),
            )
            suggestions.append(
                SuggestionResponse(
                    id=str(suggestion.id),
                    contact_id=str(suggestion.contact_id),
                    contact_name=contact.display_name,
                    suggested_response=suggestion.suggested_response,
                    context_used=suggestion.context_used,
                    status=suggestion.status,
                    created_at=suggestion.created_at,
                )
            )
        except Exception as e:
            logger.error(
                f"[SUGGEST] Failed for {contact.display_name}: {e}"
            )

    return SuggestionListResponse(suggestions=suggestions, total=len(suggestions))


@router.post("/{suggestion_id}/approve")
async def approve_suggestion(
    suggestion_id: str,
    mode: str = "draft",
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Approve a suggestion — save as Telegram draft (default) or send directly."""
    suggestion = await db.get(ResponseSuggestion, uuid.UUID(suggestion_id))
    if not suggestion or suggestion.user_id != user.id:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    contact = await db.get(Contact, suggestion.contact_id)

    # Publish to Telegram monitor via Redis
    await redis_client.publish(
        "telegram:send_commands",
        json.dumps(
            {
                "user_id": str(user.id),
                "chat_id": contact.telegram_id,
                "text": suggestion.suggested_response,
                "mode": mode,
            }
        ),
    )

    if mode == "draft":
        suggestion.status = "drafted"
    else:
        suggestion.status = "sent"
        suggestion.sent_at = datetime.utcnow()

    # Reset unresponded count
    if contact:
        contact.unresponded_count = 0

    await db.commit()

    action = "saved as draft" if mode == "draft" else "sent"
    logger.info(
        f"[SUGGEST] Suggestion {suggestion_id} {action} for {contact.display_name}"
    )

    return {"status": suggestion.status, "message": f"Message {action} for {contact.display_name}"}


@router.post("/{suggestion_id}/edit")
async def edit_and_send_suggestion(
    suggestion_id: str,
    req: EditSuggestionRequest,
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Edit a suggestion's text and save as draft or send."""
    suggestion = await db.get(ResponseSuggestion, uuid.UUID(suggestion_id))
    if not suggestion or suggestion.user_id != user.id:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    contact = await db.get(Contact, suggestion.contact_id)

    suggestion.suggested_response = req.text
    mode = req.mode

    # Publish edited version to Telegram monitor
    await redis_client.publish(
        "telegram:send_commands",
        json.dumps(
            {
                "user_id": str(user.id),
                "chat_id": contact.telegram_id,
                "text": req.text,
                "mode": mode,
            }
        ),
    )

    if mode == "draft":
        suggestion.status = "drafted"
    else:
        suggestion.status = "sent"
        suggestion.sent_at = datetime.utcnow()

    if contact:
        contact.unresponded_count = 0

    await db.commit()

    action = "saved as draft" if mode == "draft" else "sent"
    return {"status": suggestion.status, "message": f"Edited message {action} for {contact.display_name}"}


@router.delete("/{suggestion_id}")
async def reject_suggestion(
    suggestion_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Reject/discard a suggestion."""
    suggestion = await db.get(ResponseSuggestion, uuid.UUID(suggestion_id))
    if not suggestion or suggestion.user_id != user.id:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    suggestion.status = "rejected"
    await db.commit()

    return {"status": "rejected"}
