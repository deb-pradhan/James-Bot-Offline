"""
RAG retrieval service.

Performs vector similarity search against conversation_chunks and document_chunks
using pgvector, with optional contact-scoped filtering.
"""

import logging
import uuid
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, select, func
from app.services.embedding import embed_query
from app.models.chunk import ConversationChunk, DocumentChunk
from app.models.contact import Contact
from app.models.document import Document

logger = logging.getLogger(__name__)


async def retrieve_relevant_chunks(
    db: AsyncSession,
    user_id: uuid.UUID,
    query_text: str,
    contact_id: uuid.UUID | None = None,
    top_k: int = 10,
    include_documents: bool = True,
) -> dict:
    """
    Retrieve relevant conversation + document chunks via vector similarity.

    Returns:
        {
            "conversation_chunks": [{"text": ..., "contact_name": ..., "score": ..., ...}],
            "document_chunks": [{"text": ..., "document_name": ..., "score": ..., ...}],
        }
    """
    logger.info(
        f"[RETRIEVE] Query: '{query_text[:80]}...', "
        f"contact_id={contact_id}, top_k={top_k}"
    )

    # Embed the query
    query_embedding = await embed_query(
        query_text, user_id=user_id, operation="embedding_query"
    )

    # ── Conversation chunks ──
    conversation_results = []

    if contact_id:
        # Scoped to specific contact
        conv_query = text("""
            SELECT cc.id, cc.chunk_text, cc.session_start, cc.session_end,
                   cc.message_count, c.display_name,
                   1 - (cc.embedding <=> CAST(:embedding AS vector)) AS score
            FROM conversation_chunks cc
            JOIN contacts c ON cc.contact_id = c.id
            WHERE cc.user_id = :user_id
              AND cc.contact_id = :contact_id
              AND cc.embedding IS NOT NULL
            ORDER BY cc.embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """)
        result = await db.execute(
            conv_query,
            {
                "embedding": str(query_embedding),
                "user_id": str(user_id),
                "contact_id": str(contact_id),
                "top_k": top_k,
            },
        )
    else:
        # Search across all contacts
        conv_query = text("""
            SELECT cc.id, cc.chunk_text, cc.session_start, cc.session_end,
                   cc.message_count, c.display_name,
                   1 - (cc.embedding <=> CAST(:embedding AS vector)) AS score
            FROM conversation_chunks cc
            JOIN contacts c ON cc.contact_id = c.id
            WHERE cc.user_id = :user_id
              AND cc.embedding IS NOT NULL
            ORDER BY cc.embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """)
        result = await db.execute(
            conv_query,
            {
                "embedding": str(query_embedding),
                "user_id": str(user_id),
                "top_k": top_k,
            },
        )

    for row in result.fetchall():
        conversation_results.append(
            {
                "id": str(row.id),
                "text": row.chunk_text,
                "contact_name": row.display_name,
                "session_start": row.session_start.isoformat() if row.session_start else None,
                "session_end": row.session_end.isoformat() if row.session_end else None,
                "message_count": row.message_count,
                "score": float(row.score),
            }
        )

    logger.info(
        f"[RETRIEVE] Found {len(conversation_results)} conversation chunks"
    )

    # ── Document chunks ──
    document_results = []

    if include_documents:
        if contact_id:
            # Contact-scoped docs + general docs
            doc_query = text("""
                SELECT dc.id, dc.chunk_text, dc.chunk_index, d.filename,
                       1 - (dc.embedding <=> CAST(:embedding AS vector)) AS score
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE dc.user_id = :user_id
                  AND (d.contact_id = :contact_id OR d.scope = 'general')
                  AND dc.embedding IS NOT NULL
                ORDER BY dc.embedding <=> CAST(:embedding AS vector)
                LIMIT :top_k
            """)
            result = await db.execute(
                doc_query,
                {
                    "embedding": str(query_embedding),
                    "user_id": str(user_id),
                    "contact_id": str(contact_id),
                    "top_k": top_k // 2,
                },
            )
        else:
            doc_query = text("""
                SELECT dc.id, dc.chunk_text, dc.chunk_index, d.filename,
                       1 - (dc.embedding <=> CAST(:embedding AS vector)) AS score
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE dc.user_id = :user_id
                  AND dc.embedding IS NOT NULL
                ORDER BY dc.embedding <=> CAST(:embedding AS vector)
                LIMIT :top_k
            """)
            result = await db.execute(
                doc_query,
                {
                    "embedding": str(query_embedding),
                    "user_id": str(user_id),
                    "top_k": top_k // 2,
                },
            )

        for row in result.fetchall():
            document_results.append(
                {
                    "id": str(row.id),
                    "text": row.chunk_text,
                    "document_name": row.filename,
                    "chunk_index": row.chunk_index,
                    "score": float(row.score),
                }
            )

        logger.info(
            f"[RETRIEVE] Found {len(document_results)} document chunks"
        )

    return {
        "conversation_chunks": conversation_results,
        "document_chunks": document_results,
    }
