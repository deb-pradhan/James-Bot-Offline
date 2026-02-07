import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, JSON, Text, Boolean, BigInteger, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    contact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("contacts.id"),
        nullable=False,
        index=True,
    )
    telegram_msg_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    sender_type: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # "self" or "other"
    sender_name: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, index=True
    )
    is_read: Mapped[bool] = mapped_column(Boolean, default=True)
    is_responded: Mapped[bool] = mapped_column(Boolean, default=True)
    raw_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )

    contact: Mapped["Contact"] = relationship(back_populates="messages")
