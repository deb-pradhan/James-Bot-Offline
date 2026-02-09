"""Add api_usage table for cost tracking

Revision ID: 003
Revises: 002
Create Date: 2026-02-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_usage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("service", sa.String(30), nullable=False),
        sa.Column("model", sa.String(80), nullable=False),
        sa.Column("operation", sa.String(40), nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_index(
        "ix_api_usage_user_created", "api_usage", ["user_id", "created_at"]
    )
    op.create_index(
        "ix_api_usage_user_service", "api_usage", ["user_id", "service"]
    )


def downgrade() -> None:
    op.drop_index("ix_api_usage_user_service", table_name="api_usage")
    op.drop_index("ix_api_usage_user_created", table_name="api_usage")
    op.drop_table("api_usage")
