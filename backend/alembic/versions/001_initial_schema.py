"""Initial schema with pgvector

Revision ID: 001
Revises:
Create Date: 2025-02-07
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from pgvector.sqlalchemy import Vector

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 512


def upgrade() -> None:
    # Enable pgvector
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # Users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), unique=True, nullable=False, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("telegram_user_id", sa.String(100), nullable=True),
        sa.Column("telegram_session", sa.Text, nullable=True),
        sa.Column("settings", postgresql.JSON, server_default="{}"),
        sa.Column("is_active", sa.Boolean, server_default="true"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Contacts
    op.create_table(
        "contacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("telegram_id", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("username", sa.String(255), nullable=True),
        sa.Column("chat_type", sa.String(50), server_default="personal_chat"),
        sa.Column("style_profile", sa.Text, nullable=True),
        sa.Column("auto_respond", sa.Boolean, server_default="false"),
        sa.Column("metadata", postgresql.JSON, server_default="{}"),
        sa.Column("last_message_at", sa.DateTime, nullable=True),
        sa.Column("unresponded_count", sa.Integer, server_default="0"),
        sa.Column("total_messages", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Messages
    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "contact_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("contacts.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("telegram_msg_id", sa.BigInteger, nullable=True),
        sa.Column("sender_type", sa.String(20), nullable=False),
        sa.Column("sender_name", sa.String(255), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("sent_at", sa.DateTime, nullable=False, index=True),
        sa.Column("is_read", sa.Boolean, server_default="true"),
        sa.Column("is_responded", sa.Boolean, server_default="true"),
        sa.Column("raw_data", postgresql.JSON, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Documents
    op.create_table(
        "documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "contact_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("contacts.id"),
            nullable=True,
        ),
        sa.Column("filename", sa.String(500), nullable=False),
        sa.Column("doc_type", sa.String(50), nullable=False),
        sa.Column("source_url", sa.Text, nullable=True),
        sa.Column("scope", sa.String(50), server_default="general"),
        sa.Column("content_preview", sa.Text, nullable=True),
        sa.Column("chunk_count", sa.Integer, server_default="0"),
        sa.Column("uploaded_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Conversation Chunks (with vector embeddings)
    op.create_table(
        "conversation_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "contact_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("contacts.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("chunk_text", sa.Text, nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIM), nullable=True),
        sa.Column("session_start", sa.DateTime, nullable=True),
        sa.Column("session_end", sa.DateTime, nullable=True),
        sa.Column("message_count", sa.Integer, server_default="0"),
        sa.Column("metadata", postgresql.JSON, server_default="{}"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Document Chunks (with vector embeddings)
    op.create_table(
        "document_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("chunk_text", sa.Text, nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIM), nullable=True),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("metadata", postgresql.JSON, server_default="{}"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Response Suggestions
    op.create_table(
        "response_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "contact_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("contacts.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("suggested_response", sa.Text, nullable=False),
        sa.Column("context_used", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("sent_at", sa.DateTime, nullable=True),
    )

    # Create HNSW vector similarity indexes (works on empty tables, better recall)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conv_chunks_embedding "
        "ON conversation_chunks USING hnsw (embedding vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_doc_chunks_embedding "
        "ON document_chunks USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_table("response_suggestions")
    op.drop_table("document_chunks")
    op.drop_table("conversation_chunks")
    op.drop_table("documents")
    op.drop_table("messages")
    op.drop_table("contacts")
    op.drop_table("users")
