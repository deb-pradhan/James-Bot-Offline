"""Add telegram_api_id and telegram_api_hash to users table

Revision ID: 004
Revises: 003
Create Date: 2026-02-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "004"
down_revision: Union[str, None] = "003b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("telegram_api_id", sa.Integer, nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("telegram_api_hash", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "telegram_api_hash")
    op.drop_column("users", "telegram_api_id")
