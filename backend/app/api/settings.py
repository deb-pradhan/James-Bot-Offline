"""
Settings routes — Telegram connection (OTP flow), user preferences.
"""

import logging
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from telethon import TelegramClient
from telethon.sessions import StringSession

from app.database import get_db
from app.api.deps import get_current_user, get_redis
from app.models.user import User
from app.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])


class TelegramCredentials(BaseModel):
    api_id: int
    api_hash: str
    phone: str


class VerifyCodeRequest(BaseModel):
    code: str
    phone_code_hash: str | None = None


class TelegramStatusResponse(BaseModel):
    connected: bool
    phone: str | None = None
    user_id: str | None = None


# In-memory store for pending auth flows (single-instance ok for Railway)
_pending_auth: dict[str, dict] = {}


@router.post("/telegram/request-code")
async def request_telegram_code(
    creds: TelegramCredentials,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Step 1: Initiate Telegram login — sends OTP to the phone.
    """
    logger.info(f"[SETTINGS] Telegram code request for {user.email}, phone: {creds.phone}")

    try:
        client = TelegramClient(
            StringSession(), creds.api_id, creds.api_hash
        )
        await client.connect()
        result = await client.send_code_request(creds.phone)

        # Store pending client for verification step
        _pending_auth[str(user.id)] = {
            "client": client,
            "phone": creds.phone,
            "api_id": creds.api_id,
            "api_hash": creds.api_hash,
            "phone_code_hash": result.phone_code_hash,
        }

        logger.info(f"[SETTINGS] OTP sent to {creds.phone}")
        return {
            "status": "code_sent",
            "message": "Verification code sent to your Telegram app",
            "phone_code_hash": result.phone_code_hash,
        }
    except Exception as e:
        logger.error(f"[SETTINGS] Failed to send code: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to send code: {str(e)}")


@router.post("/telegram/verify-code")
async def verify_telegram_code(
    req: VerifyCodeRequest,
    db: AsyncSession = Depends(get_db),
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Step 2: Verify OTP and complete Telegram login.
    Saves session string to DB for the monitor service.
    """
    user_id_str = str(user.id)
    pending = _pending_auth.get(user_id_str)

    if not pending:
        raise HTTPException(
            status_code=400,
            detail="No pending auth flow. Call request-code first.",
        )

    client: TelegramClient = pending["client"]
    phone = pending["phone"]
    phone_code_hash = req.phone_code_hash or pending["phone_code_hash"]

    try:
        await client.sign_in(phone, req.code, phone_code_hash=phone_code_hash)
        me = await client.get_me()

        # Save session string + credentials to DB (persistent across restarts)
        session_string = client.session.save()
        user.telegram_session = session_string
        user.telegram_user_id = str(me.id)
        user.telegram_api_id = pending["api_id"]
        user.telegram_api_hash = pending["api_hash"]

        # Update user display name from Telegram profile
        tg_name = " ".join(
            filter(None, [me.first_name, me.last_name])
        ) or me.username or user.name
        user.name = tg_name

        # Store connection info in Redis for monitor (immediate pickup)
        import json
        await redis_client.set(
            f"telegram:session:{user_id_str}",
            json.dumps({
                "session_string": session_string,
                "api_id": pending["api_id"],
                "api_hash": pending["api_hash"],
            }),
        )
        await redis_client.set(f"telegram:connected:{user_id_str}", "true")
        await redis_client.publish(
            "telegram:session_updated",
            json.dumps({"user_id": user_id_str}),
        )

        await db.commit()
        await client.disconnect()
        del _pending_auth[user_id_str]

        logger.info(
            f"[SETTINGS] Telegram connected for {user.email} as {me.first_name} ({me.id})"
        )

        return {
            "status": "connected",
            "message": f"Connected as {me.first_name}",
            "telegram_user_id": str(me.id),
        }
    except Exception as e:
        logger.error(f"[SETTINGS] Verification failed: {e}")
        raise HTTPException(
            status_code=400, detail=f"Verification failed: {str(e)}"
        )


@router.get("/telegram/status", response_model=TelegramStatusResponse)
async def telegram_status(
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Check Telegram connection status."""
    connected = await redis_client.get(f"telegram:connected:{str(user.id)}")
    return TelegramStatusResponse(
        connected=connected == "true",
        phone=None,
        user_id=user.telegram_user_id,
    )


@router.get("/available-models")
async def get_available_models(
    user: User = Depends(get_current_user),
):
    """Return available LLM models and the user's current selection."""
    settings = get_settings()
    user_settings = user.settings or {}
    current_model = user_settings.get("llm_model", settings.anthropic_model)
    return {
        "models": settings.available_models,
        "current": current_model,
        "default": settings.anthropic_model,
    }


@router.put("/preferences")
async def update_preferences(
    preferences: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update user preferences/settings."""
    user.settings = {**(user.settings or {}), **preferences}
    await db.commit()
    logger.info(f"[SETTINGS] Updated preferences for {user.email}")
    return {"status": "updated", "settings": user.settings}


class ValidateApiKeyRequest(BaseModel):
    api_key: str


@router.post("/validate-api-key")
async def validate_anthropic_api_key(
    req: ValidateApiKeyRequest,
    user: User = Depends(get_current_user),
):
    """Validate a custom Anthropic API key by making a minimal API call."""
    from anthropic import AsyncAnthropic, APIError

    try:
        client = AsyncAnthropic(api_key=req.api_key)
        # Make a minimal call to validate the key
        await client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=1,
            messages=[{"role": "user", "content": "Hi"}],
        )
        return {"valid": True, "message": "API key is valid"}
    except APIError as e:
        logger.warning(f"[SETTINGS] Invalid API key for {user.email}: {e}")
        return {"valid": False, "message": f"Invalid API key: {e.message}"}
    except Exception as e:
        logger.error(f"[SETTINGS] API key validation error: {e}")
        return {"valid": False, "message": f"Validation failed: {str(e)}"}


@router.get("/ai-status")
async def get_ai_status(
    user: User = Depends(get_current_user),
):
    """Get AI enabled status and custom API key info."""
    user_settings = user.settings or {}
    has_custom_key = bool(user_settings.get("anthropic_api_key"))
    return {
        "ai_enabled": user_settings.get("ai_enabled", True),
        "has_custom_api_key": has_custom_key,
        "using_custom_key": has_custom_key,
    }


class DeleteDataRequest(BaseModel):
    confirm: bool
    keep_account: bool = True  # If False, also deletes the user account


@router.delete("/delete-all-data")
async def delete_all_user_data(
    req: DeleteDataRequest,
    db: AsyncSession = Depends(get_db),
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Delete all user data including contacts, messages, documents, suggestions,
    ingestion jobs, API usage, and Redis keys. Optionally keeps the account.
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="Confirmation required")

    user_id_str = str(user.id)
    user_email = user.email  # Cache before any DB ops that might expire the object
    logger.info(f"[SETTINGS] Deleting all data for user {user_email}")

    try:
        from app.models.contact import Contact
        from app.models.message import Message
        from app.models.chunk import ConversationChunk, DocumentChunk
        from app.models.document import Document
        from app.models.suggestion import ResponseSuggestion
        from app.models.job import IngestionJob
        from app.models.api_usage import ApiUsage
        from sqlalchemy import delete, select

        # Bulk delete() bypasses ORM cascade, so we must delete in correct FK order:
        # Delete children before parents

        # 1. Get all contact IDs for this user (needed for child table deletes)
        contact_ids_result = await db.execute(
            select(Contact.id).where(Contact.user_id == user.id)
        )
        contact_ids = [row[0] for row in contact_ids_result.fetchall()]

        # 2. Get all document IDs for this user
        doc_ids_result = await db.execute(
            select(Document.id).where(Document.user_id == user.id)
        )
        doc_ids = [row[0] for row in doc_ids_result.fetchall()]

        # 3. Delete leaf tables (children) first
        if contact_ids:
            # Messages (child of Contact)
            await db.execute(
                delete(Message).where(Message.contact_id.in_(contact_ids))
            )
            # ConversationChunks (child of Contact)
            await db.execute(
                delete(ConversationChunk).where(ConversationChunk.contact_id.in_(contact_ids))
            )
            # Suggestions via contact (child of Contact)
            await db.execute(
                delete(ResponseSuggestion).where(ResponseSuggestion.contact_id.in_(contact_ids))
            )

        if doc_ids:
            # DocumentChunks (child of Document)
            await db.execute(
                delete(DocumentChunk).where(DocumentChunk.document_id.in_(doc_ids))
            )

        # 4. Delete parent tables
        await db.execute(delete(Contact).where(Contact.user_id == user.id))
        await db.execute(delete(Document).where(Document.user_id == user.id))

        # 5. Delete remaining user-owned records (no FK children)
        await db.execute(delete(ResponseSuggestion).where(ResponseSuggestion.user_id == user.id))
        await db.execute(delete(IngestionJob).where(IngestionJob.user_id == user.id))
        await db.execute(delete(ApiUsage).where(ApiUsage.user_id == user.id))

        # 6. Clean up Redis keys for this user
        redis_keys_to_delete = [
            f"telegram:session:{user_id_str}",
            f"telegram:connected:{user_id_str}",
            f"user:paused:{user_id_str}",
            f"user:paused_at:{user_id_str}",
        ]
        for key in redis_keys_to_delete:
            await redis_client.delete(key)

        # 7. Clear Telegram credentials from user (disconnect)
        user.telegram_session = None
        user.telegram_user_id = None
        user.telegram_api_id = None
        user.telegram_api_hash = None

        # 8. Reset user settings to defaults
        user.settings = {}

        if not req.keep_account:
            # Delete the user account entirely
            await db.delete(user)
            await db.commit()
            logger.info(f"[SETTINGS] Deleted account and all data for {user_email}")
            return {
                "status": "deleted",
                "message": "Account and all data have been permanently deleted",
            }

        await db.commit()

        # Notify connected clients that data was cleared
        import json
        await redis_client.publish(
            f"user:{user_id_str}:events",
            json.dumps({
                "type": "data_deleted",
                "message": "All your data has been deleted",
            }),
        )

        logger.info(f"[SETTINGS] Deleted all data for {user_email}, account retained")
        return {
            "status": "deleted",
            "message": "All data has been permanently deleted. Your account remains active.",
        }

    except Exception as e:
        await db.rollback()
        logger.error(f"[SETTINGS] Failed to delete data for {user_email}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete data: {str(e)}")
