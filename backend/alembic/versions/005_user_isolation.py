"""Add user_id columns to chunks/messages and unique constraint for message dedup

Revision ID: 005
Revises: 004
Create Date: 2026-02-12

Gap 4: Add user_id FK to conversation_chunks, document_chunks, messages
       for direct user-level filtering without JOINs.
Gap 6: Add partial unique index on (contact_id, telegram_msg_id) for
       race-condition-safe message dedup at DB level.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Gap 6: Unique constraint for message dedup ──
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_contact_telegram_msg "
        "ON messages(contact_id, telegram_msg_id) "
        "WHERE telegram_msg_id IS NOT NULL"
    )

    # ── Gap 4: Add user_id columns (nullable first for backfill) ──

    # conversation_chunks
    op.add_column(
        "conversation_chunks",
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
    )

    # document_chunks
    op.add_column(
        "document_chunks",
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
    )

    # messages
    op.add_column(
        "messages",
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
    )

    # ── Backfill from parent tables ──
    op.execute(
        "UPDATE conversation_chunks "
        "SET user_id = c.user_id "
        "FROM contacts c "
        "WHERE conversation_chunks.contact_id = c.id "
        "AND conversation_chunks.user_id IS NULL"
    )

    op.execute(
        "UPDATE document_chunks "
        "SET user_id = d.user_id "
        "FROM documents d "
        "WHERE document_chunks.document_id = d.id "
        "AND document_chunks.user_id IS NULL"
    )

    op.execute(
        "UPDATE messages "
        "SET user_id = c.user_id "
        "FROM contacts c "
        "WHERE messages.contact_id = c.id "
        "AND messages.user_id IS NULL"
    )

    # ── Set NOT NULL after backfill ──
    op.alter_column("conversation_chunks", "user_id", nullable=False)
    op.alter_column("document_chunks", "user_id", nullable=False)
    op.alter_column("messages", "user_id", nullable=False)

    # ── Add FK constraints ──
    op.create_foreign_key(
        "fk_conversation_chunks_user_id",
        "conversation_chunks",
        "users",
        ["user_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_document_chunks_user_id",
        "document_chunks",
        "users",
        ["user_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_messages_user_id",
        "messages",
        "users",
        ["user_id"],
        ["id"],
    )

    # ── Add indexes for user-scoped queries ──
    op.create_index(
        "ix_conversation_chunks_user_id",
        "conversation_chunks",
        ["user_id"],
    )
    op.create_index(
        "ix_document_chunks_user_id",
        "document_chunks",
        ["user_id"],
    )
    op.create_index(
        "ix_messages_user_id",
        "messages",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_user_id", table_name="messages")
    op.drop_index("ix_document_chunks_user_id", table_name="document_chunks")
    op.drop_index("ix_conversation_chunks_user_id", table_name="conversation_chunks")

    op.drop_constraint("fk_messages_user_id", "messages", type_="foreignkey")
    op.drop_constraint("fk_document_chunks_user_id", "document_chunks", type_="foreignkey")
    op.drop_constraint("fk_conversation_chunks_user_id", "conversation_chunks", type_="foreignkey")

    op.drop_column("messages", "user_id")
    op.drop_column("document_chunks", "user_id")
    op.drop_column("conversation_chunks", "user_id")

    op.execute("DROP INDEX IF EXISTS uq_messages_contact_telegram_msg")
