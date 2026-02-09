import logging
from datetime import datetime, timedelta
import bcrypt
from jose import JWTError, jwt
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": user_id, "exp": expire}
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    logger.debug(f"Created access token for user {user_id}")
    return token


def decode_access_token(token: str) -> str | None:
    """Returns user_id or None if invalid."""
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        return payload.get("sub")
    except JWTError:
        logger.warning("Invalid JWT token")
        return None


def create_reset_token(user_id: str, password_hash: str) -> str:
    """Create a short-lived JWT for password reset.

    Embeds a fragment of the current password hash so the token
    auto-invalidates once the password is changed.
    """
    expire = datetime.utcnow() + timedelta(
        minutes=settings.reset_token_expire_minutes
    )
    payload = {
        "sub": user_id,
        "purpose": "password_reset",
        "phash": password_hash[:16],  # first 16 chars as fingerprint
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_reset_token(token: str) -> dict | None:
    """Decode a password-reset JWT. Returns {"sub": user_id, "phash": ...} or None."""
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        if payload.get("purpose") != "password_reset":
            logger.warning("Token is not a password reset token")
            return None
        return payload
    except JWTError:
        logger.warning("Invalid reset token")
        return None
