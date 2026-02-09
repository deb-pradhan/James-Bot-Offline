import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, Integer, Float, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class ApiUsage(Base):
    __tablename__ = "api_usage"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    # "anthropic", "openai", "voyageai"
    service: Mapped[str] = mapped_column(String(30), nullable=False)
    # e.g. "claude-sonnet-4-20250514", "text-embedding-3-small"
    model: Mapped[str] = mapped_column(String(80), nullable=False)
    # "ghostwrite", "query", "style_analysis", "embedding_document",
    # "embedding_query", "embedding_ingest"
    operation: Mapped[str] = mapped_column(String(40), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    # Cost in USD, calculated at record time using known pricing
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )

    __table_args__ = (
        Index("ix_api_usage_user_created", "user_id", "created_at"),
        Index("ix_api_usage_user_service", "user_id", "service"),
    )
