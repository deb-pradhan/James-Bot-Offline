"""Document management routes."""

import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc

from app.database import get_db
from app.api.deps import get_current_user
from app.models.user import User
from app.models.document import Document
from app.schemas.document import DocumentResponse, DocumentListResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    scope: str | None = Query(None),
    contact_id: str | None = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List uploaded documents."""
    stmt = select(Document).where(Document.user_id == user.id)

    if scope:
        stmt = stmt.where(Document.scope == scope)
    if contact_id:
        stmt = stmt.where(Document.contact_id == uuid.UUID(contact_id))

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = stmt.order_by(desc(Document.uploaded_at)).offset(offset).limit(limit)
    result = await db.execute(stmt)
    docs = result.scalars().all()

    return DocumentListResponse(
        documents=[
            DocumentResponse(
                id=str(d.id),
                filename=d.filename,
                doc_type=d.doc_type,
                source_url=d.source_url,
                scope=d.scope,
                contact_id=str(d.contact_id) if d.contact_id else None,
                content_preview=d.content_preview,
                chunk_count=d.chunk_count,
                uploaded_at=d.uploaded_at,
            )
            for d in docs
        ],
        total=total,
    )


@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a document and all its chunks."""
    doc = await db.get(Document, uuid.UUID(document_id))
    if not doc or doc.user_id != user.id:
        raise HTTPException(status_code=404, detail="Document not found")

    await db.delete(doc)  # Cascades to chunks
    await db.commit()
    logger.info(f"[DOCS] Deleted document: {doc.filename}")

    return {"status": "deleted", "filename": doc.filename}
