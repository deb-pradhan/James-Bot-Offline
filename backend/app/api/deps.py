"""
FastAPI dependency injection — DB session, current user, Redis.
"""

import logging
import uuid
import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.utils.auth import decode_access_token
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

security = HTTPBearer()

_redis_pool: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """Get or create Redis connection."""
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.redis_url, decode_responses=True
        )
    return _redis_pool


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Validate JWT and return current user."""
    token = credentials.credentials
    user_id = decode_access_token(token)

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    user = await db.get(User, uuid.UUID(user_id))
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    return user


def get_user_llm_model(user: User) -> str | None:
    """Extract user's preferred LLM model from settings, or None for default."""
    user_settings = user.settings or {}
    model = user_settings.get("llm_model")
    if model:
        valid_ids = [m["id"] for m in settings.available_models]
        if model in valid_ids:
            return model
    return None


def get_user_settings(user: User) -> dict:
    """Get user settings with defaults applied."""
    defaults = {
        "ai_enabled": True,
        "llm_model": None,
        "anthropic_api_key": None,
    }
    return {**defaults, **(user.settings or {})}
