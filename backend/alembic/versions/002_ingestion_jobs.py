"""Add ingestion_jobs table

Revision ID: 002
Revises: 001
Create Date: 2026-02-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ingestion_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("status", sa.String(20), nullable=False, server_default="processing"),
        sa.Column("step", sa.String(50), nullable=True),
        sa.Column("progress", sa.Integer, nullable=True),
        sa.Column("total", sa.Integer, nullable=True),
        sa.Column("message", sa.Text, nullable=True),
        sa.Column("result", postgresql.JSON, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_index(
        "ix_ingestion_jobs_user_status",
        "ingestion_jobs",
        ["user_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_ingestion_jobs_user_status", table_name="ingestion_jobs")
    op.drop_table("ingestion_jobs")
