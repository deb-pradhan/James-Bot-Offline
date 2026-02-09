import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, JSON, Boolean, Text, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    telegram_user_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True
    )
    telegram_session: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    telegram_api_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    telegram_api_hash: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    contacts: Mapped[list["Contact"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    suggestions: Mapped[list["ResponseSuggestion"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
