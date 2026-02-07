import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, JSON, Text, Integer, Boolean, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    telegram_id: Mapped[str] = mapped_column(String(100), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    chat_type: Mapped[str] = mapped_column(
        String(50), default="personal_chat"
    )
    style_profile: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_respond: Mapped[bool] = mapped_column(Boolean, default=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    unresponded_count: Mapped[int] = mapped_column(Integer, default=0)
    total_messages: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )

    user: Mapped["User"] = relationship(back_populates="contacts")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="contact", cascade="all, delete-orphan"
    )
    conversation_chunks: Mapped[list["ConversationChunk"]] = relationship(
        back_populates="contact", cascade="all, delete-orphan"
    )
    suggestions: Mapped[list["ResponseSuggestion"]] = relationship(
        back_populates="contact", cascade="all, delete-orphan"
    )
