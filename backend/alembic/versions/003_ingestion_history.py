"""Add ingestion history columns to ingestion_jobs

Revision ID: 003
Revises: 002
Create Date: 2026-02-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "003b"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ingestion_jobs",
        sa.Column("filename", sa.String(500), nullable=True),
    )
    op.add_column(
        "ingestion_jobs",
        sa.Column("file_hash", sa.String(64), nullable=True),
    )
    op.add_column(
        "ingestion_jobs",
        sa.Column("chat_date_start", sa.DateTime, nullable=True),
    )
    op.add_column(
        "ingestion_jobs",
        sa.Column("chat_date_end", sa.DateTime, nullable=True),
    )
    op.add_column(
        "ingestion_jobs",
        sa.Column("total_messages_in_file", sa.Integer, nullable=True),
    )
    op.add_column(
        "ingestion_jobs",
        sa.Column("messages_skipped", sa.Integer, nullable=True),
    )

    # Index for dupe checks by file hash
    op.create_index(
        "ix_ingestion_jobs_file_hash",
        "ingestion_jobs",
        ["file_hash"],
    )


def downgrade() -> None:
    op.drop_index("ix_ingestion_jobs_file_hash", table_name="ingestion_jobs")
    op.drop_column("ingestion_jobs", "messages_skipped")
    op.drop_column("ingestion_jobs", "total_messages_in_file")
    op.drop_column("ingestion_jobs", "chat_date_end")
    op.drop_column("ingestion_jobs", "chat_date_start")
    op.drop_column("ingestion_jobs", "file_hash")
    op.drop_column("ingestion_jobs", "filename")
