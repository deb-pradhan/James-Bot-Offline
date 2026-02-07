"""
Ingestion routes: upload Telegram JSON, documents, URLs.
"""

import logging
import uuid
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis
from app.models.user import User
from app.models.document import Document
from app.models.chunk import DocumentChunk
from app.schemas.ingest import IngestResponse, UrlIngestRequest
from app.services.ingestion import ingest_telegram_export
from app.services.document_parser import parse_document, chunk_document_text
from app.services.embedding import embed_texts

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("/telegram", response_model=IngestResponse)
async def upload_telegram_export(
    file: UploadFile = File(...),
    self_user_id: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Upload a Telegram Desktop JSON export for ingestion.

    The entire pipeline runs in the background:
    parse → import → chunk → embed → style-analyze.
    Progress is streamed via WebSocket.
    """
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Please upload a .json file")

    logger.info(
        f"[INGEST] Telegram export upload by {user.email}: {file.filename}"
    )

    content = await file.read()
    job_id = str(uuid.uuid4())

    # Run ingestion in background (using asyncio.create_task for now)
    import asyncio
    from app.database import async_session

    async def run_ingestion():
        async with async_session() as bg_db:
            try:
                result = await ingest_telegram_export(
                    db=bg_db,
                    redis_client=redis_client,
                    user_id=user.id,
                    file_content=content,
                    user_name=user.name,
                    self_user_id_override=self_user_id or None,
                )
                await bg_db.commit()
                logger.info(f"[INGEST] Job {job_id} completed: {result}")
            except Exception as e:
                logger.error(f"[INGEST] Job {job_id} failed: {e}", exc_info=True)
                import json

                await redis_client.publish(
                    f"user:{str(user.id)}:events",
                    json.dumps(
                        {
                            "type": "error",
                            "message": f"Ingestion failed: {str(e)}",
                        }
                    ),
                )

    asyncio.create_task(run_ingestion())

    return IngestResponse(
        job_id=job_id,
        status="processing",
        message="Ingestion started. Check the dashboard for progress.",
    )


@router.post("/document", response_model=IngestResponse)
async def upload_document(
    file: UploadFile = File(...),
    contact_id: str | None = Form(None),
    scope: str = Form("general"),
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Upload a document (PDF, DOCX, TXT, MD) to the knowledge base.
    Optionally associate with a specific contact.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    logger.info(f"[INGEST] Document upload: {file.filename} by {user.email}")

    content = await file.read()
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "unknown"

    # Parse document
    try:
        text = await parse_document(file.filename, content=content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not text.strip():
        raise HTTPException(status_code=400, detail="No text content found in document")

    # Create document record
    doc = Document(
        user_id=user.id,
        contact_id=uuid.UUID(contact_id) if contact_id else None,
        filename=file.filename,
        doc_type=ext,
        scope=scope,
        content_preview=text[:500],
    )
    db.add(doc)
    await db.flush()

    # Chunk and embed
    chunks = chunk_document_text(text)
    doc.chunk_count = len(chunks)

    logger.info(f"[INGEST] Document chunked into {len(chunks)} chunks, embedding...")

    embeddings = await embed_texts(chunks, input_type="document")

    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        db.add(
            DocumentChunk(
                document_id=doc.id,
                chunk_text=chunk_text,
                embedding=embedding,
                chunk_index=i,
            )
        )

    await db.commit()
    logger.info(f"[INGEST] Document {file.filename} ingested: {len(chunks)} chunks")

    return IngestResponse(
        job_id=str(doc.id),
        status="complete",
        message=f"Document uploaded and indexed ({len(chunks)} chunks).",
    )


@router.post("/url", response_model=IngestResponse)
async def ingest_url(
    req: UrlIngestRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Scrape and ingest content from a URL."""
    logger.info(f"[INGEST] URL ingest: {req.url} by {user.email}")

    try:
        text = await parse_document("url.html", url=req.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(e)}")

    if not text.strip():
        raise HTTPException(status_code=400, detail="No content extracted from URL")

    doc = Document(
        user_id=user.id,
        contact_id=uuid.UUID(req.contact_id) if req.contact_id else None,
        filename=req.url[:200],
        doc_type="url",
        source_url=req.url,
        scope=req.scope,
        content_preview=text[:500],
    )
    db.add(doc)
    await db.flush()

    chunks = chunk_document_text(text)
    doc.chunk_count = len(chunks)

    embeddings = await embed_texts(chunks, input_type="document")

    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        db.add(
            DocumentChunk(
                document_id=doc.id,
                chunk_text=chunk_text,
                embedding=embedding,
                chunk_index=i,
            )
        )

    await db.commit()
    logger.info(f"[INGEST] URL ingested: {len(chunks)} chunks from {req.url}")

    return IngestResponse(
        job_id=str(doc.id),
        status="complete",
        message=f"URL content indexed ({len(chunks)} chunks).",
    )
