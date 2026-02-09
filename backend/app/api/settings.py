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
