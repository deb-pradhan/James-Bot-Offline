"""Auth routes: register, login, password reset."""

import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.user import User
from app.schemas.auth import (
    RegisterRequest,
    LoginRequest,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    MessageResponse,
    TokenResponse,
    UserResponse,
)
from app.utils.auth import (
    hash_password,
    verify_password,
    create_access_token,
    create_reset_token,
    decode_reset_token,
)
from app.utils.email import send_password_reset_email
from app.api.deps import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new user."""
    logger.info(f"[AUTH] Registration attempt: {req.email}")

    # Check if email exists
    stmt = select(User).where(User.email == req.email)
    result = await db.execute(stmt)
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        email=req.email,
        name=req.name,
        hashed_password=hash_password(req.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    token = create_access_token(str(user.id))
    logger.info(f"[AUTH] User registered: {user.email} ({user.id})")

    return TokenResponse(
        access_token=token,
        user=UserResponse(
            id=str(user.id),
            email=user.email,
            name=user.name,
            created_at=user.created_at,
        ),
    )


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login with email + password."""
    logger.info(f"[AUTH] Login attempt: {req.email}")

    stmt = select(User).where(User.email == req.email)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token(str(user.id))
    logger.info(f"[AUTH] Login successful: {user.email}")

    return TokenResponse(
        access_token=token,
        user=UserResponse(
            id=str(user.id),
            email=user.email,
            name=user.name,
            telegram_user_id=user.telegram_user_id,
            settings=user.settings or {},
            created_at=user.created_at,
        ),
    )


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(req: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Request a password reset email."""
    logger.info(f"[AUTH] Password reset requested for: {req.email}")

    stmt = select(User).where(User.email == req.email)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    # Always return success to prevent email enumeration
    if not user:
        logger.info(f"[AUTH] Password reset for unknown email: {req.email}")
        return MessageResponse(message="If an account with that email exists, a reset link has been sent.")

    token = create_reset_token(str(user.id), user.hashed_password)
    await send_password_reset_email(user.email, token)

    return MessageResponse(message="If an account with that email exists, a reset link has been sent.")


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(req: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Reset password using a valid reset token."""
    payload = decode_reset_token(req.token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset link",
        )

    user_id = payload.get("sub")
    phash_fragment = payload.get("phash")

    stmt = select(User).where(User.id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset link",
        )

    # Verify the token was issued for the current password
    # (invalidates token if password was already changed)
    if user.hashed_password[:16] != phash_fragment:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link has already been used",
        )

    user.hashed_password = hash_password(req.password)
    await db.commit()
    logger.info(f"[AUTH] Password reset successful for: {user.email}")

    return MessageResponse(message="Password has been reset successfully. You can now sign in.")


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)):
    """Get current authenticated user."""
    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        telegram_user_id=user.telegram_user_id,
        settings=user.settings or {},
        created_at=user.created_at,
    )
