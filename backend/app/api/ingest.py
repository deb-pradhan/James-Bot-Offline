"""
Ingestion routes: upload Telegram JSON, documents, URLs.
"""

import hashlib
import logging
import uuid
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func, delete, update
import redis.asyncio as aioredis

from app.database import get_db
from app.api.deps import get_current_user, get_redis
from app.models.user import User
from app.models.contact import Contact
from app.models.document import Document
from app.models.chunk import DocumentChunk
from app.models.job import IngestionJob
from app.schemas.ingest import (
    IngestResponse,
    IngestStatusResponse,
    UrlIngestRequest,
    IngestionHistoryItem,
    IngestionHistoryResponse,
)
from app.services.ingestion import ingest_telegram_export
from app.services.document_parser import parse_document, chunk_document_text
from app.services.embedding import embed_texts
from app.api.deps import get_user_llm_model, get_user_settings

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
    file_hash = hashlib.sha256(content).hexdigest()

    # ── Check for duplicate / overlapping ingestions ──
    duplicate_warning: str | None = None
    overlap_warning: str | None = None

    # Exact file duplicate check
    dupe_stmt = select(IngestionJob).where(
        IngestionJob.user_id == user.id,
        IngestionJob.file_hash == file_hash,
        IngestionJob.status == "complete",
    )
    dupe_result = await db.execute(dupe_stmt)
    dupe_job = dupe_result.scalar_one_or_none()
    if dupe_job:
        dupe_date = dupe_job.created_at.strftime("%Y-%m-%d %H:%M")
        duplicate_warning = (
            f"This exact file was already ingested on {dupe_date}. "
            f"Proceeding anyway — duplicate messages will be skipped."
        )
        logger.info(f"[INGEST] Duplicate file detected (hash={file_hash[:12]}...)")

    # Create job row in DB before spawning background task
    job = IngestionJob(user_id=user.id, status="processing")
    db.add(job)
    await db.commit()
    await db.refresh(job)
    job_id = job.id
    upload_filename = file.filename
    user_model = get_user_llm_model(user)
    user_prefs = get_user_settings(user)

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
                    job_id=job_id,
                    filename=upload_filename,
                    model=user_model,
                    user_settings=user_prefs,
                )
                await bg_db.commit()
                logger.info(f"[INGEST] Job {job_id} completed: {result}")
            except Exception as e:
                logger.error(f"[INGEST] Job {job_id} failed: {e}", exc_info=True)
                # Mark job failed in DB
                async with async_session() as err_db:
                    stmt = select(IngestionJob).where(IngestionJob.id == job_id)
                    res = await err_db.execute(stmt)
                    failed_job = res.scalar_one_or_none()
                    if failed_job:
                        failed_job.status = "failed"
                        failed_job.error = str(e)
                        await err_db.commit()

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
        job_id=str(job_id),
        status="processing",
        message="Ingestion started. Check the dashboard for progress.",
        duplicate_warning=duplicate_warning,
        overlap_warning=overlap_warning,
    )


@router.get("/active", response_model=IngestStatusResponse | None)
async def get_active_job(
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Return the most recent active (processing) job for the current user.
    If no processing job, return the last completed/failed job within 60s.
    Also returns global pause state so the frontend can show a Resume button.
    """
    user_id_str = str(user.id)

    # Check global pause state
    paused_at_str = await redis_client.get(f"user:paused:{user_id_str}")
    globally_paused = paused_at_str is not None

    # First check for processing or paused jobs
    stmt = (
        select(IngestionJob)
        .where(
            IngestionJob.user_id == user.id,
            IngestionJob.status.in_(["processing", "paused"]),
        )
        .order_by(IngestionJob.created_at.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    job = result.scalar_one_or_none()

    if not job:
        # Check for recently finished jobs (within 60s)
        cutoff = datetime.utcnow() - timedelta(seconds=60)
        stmt = (
            select(IngestionJob)
            .where(
                IngestionJob.user_id == user.id,
                IngestionJob.status.in_(["complete", "failed"]),
                IngestionJob.updated_at >= cutoff,
            )
            .order_by(IngestionJob.updated_at.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        job = result.scalar_one_or_none()

    if not job and not globally_paused:
        return None

    # If globally paused but no active/recent job, return a synthetic status
    if not job:
        return IngestStatusResponse(
            job_id="none",
            status="globally_paused",
            message="All processing is paused.",
            globally_paused=True,
            paused_at=paused_at_str,
        )

    # If globally paused but the DB still says "processing" (pipeline hasn't
    # reached a checkpoint yet), report "paused" to the frontend so the UI
    # doesn't flicker back to "processing" during the poll window.
    effective_status = job.status
    if globally_paused and job.status == "processing":
        effective_status = "paused"

    return IngestStatusResponse(
        job_id=str(job.id),
        status=effective_status,
        step=job.step,
        progress=job.progress,
        total=job.total,
        message=job.message,
        result=job.result,
        globally_paused=globally_paused,
        paused_at=paused_at_str,
    )


@router.post("/pause")
async def pause_ingestion(
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Pause ALL processing for this user: ingestion pipeline, message consumer,
    chunking, embedding, and auto-suggestions."""
    user_id_str = str(user.id)
    paused_at = datetime.utcnow().isoformat()

    # Global pause flag — checked by ingestion pipeline, message consumer,
    # monitor handlers, sync, and periodic rechunker. Single source of truth.
    await redis_client.set(f"user:paused:{user_id_str}", paused_at)

    logger.info(f"[INGEST] Global pause requested by {user.email} at {paused_at}")
    return {"status": "ok", "message": "All processing paused."}


@router.post("/resume")
async def resume_ingestion(
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Resume ALL processing: ingestion pipeline + background message processing.
    Triggers catch-up for messages that arrived during the pause window."""
    import asyncio
    from app.services.message_consumer import run_catchup_processing

    user_id_str = str(user.id)

    # Read the pause timestamp before clearing
    paused_at_str = await redis_client.get(f"user:paused:{user_id_str}")

    # Clear global pause (single key used by all services)
    await redis_client.delete(f"user:paused:{user_id_str}")

    # Trigger catch-up: rechunk + embed contacts that got new messages while paused
    if paused_at_str:
        paused_at = datetime.fromisoformat(paused_at_str)
        asyncio.create_task(
            run_catchup_processing(user.id, paused_at, redis_client)
        )
        logger.info(
            f"[INGEST] Global resume + catch-up from {paused_at_str} "
            f"requested by {user.email}"
        )
    else:
        logger.info(f"[INGEST] Resume requested by {user.email} (no pause timestamp found)")

    return {"status": "ok", "message": "Processing resumed. Catching up on queued data."}


@router.post("/stop-analysis")
async def stop_style_analysis(
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Signal the running ingestion to stop style analysis early."""
    cancel_key = f"ingest:cancel_analysis:{str(user.id)}"
    await redis_client.set(cancel_key, "1", ex=300)  # auto-expire after 5min
    logger.info(f"[INGEST] Style analysis stop requested by {user.email}")
    return {"status": "ok", "message": "Stop signal sent. Analysis will halt after the current contact."}


@router.post("/stop")
async def stop_ingestion(
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Stop ingestion AND pause all background processing.
    The user must call /resume to restart background processing and trigger catch-up."""
    user_id_str = str(user.id)
    paused_at = datetime.utcnow().isoformat()

    # Global pause — background processing stops until explicit resume
    await redis_client.set(f"user:paused:{user_id_str}", paused_at)

    # Cancel the running ingestion pipeline
    await redis_client.set(f"ingest:cancel_job:{user_id_str}", "1", ex=600)

    logger.info(f"[INGEST] Full stop + global pause requested by {user.email}")
    return {
        "status": "ok",
        "message": "Stopping ingestion and pausing all processing.",
    }


@router.get("/history", response_model=IngestionHistoryResponse)
async def get_ingestion_history(
    limit: int = 20,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Return history of past Telegram export ingestions for the current user.
    Includes date ranges, message counts, and dedup stats.
    """
    # Count total completed/failed jobs (not "processing" — those are in-flight)
    count_stmt = select(IngestionJob).where(
        IngestionJob.user_id == user.id,
        IngestionJob.status.in_(["complete", "failed"]),
        # Only telegram ingestions have file_hash or filename set
        # But also include older ones without it for completeness
    )
    count_result = await db.execute(
        select(func.count()).select_from(count_stmt.subquery())
    )
    total = count_result.scalar() or 0

    # Fetch paginated history
    stmt = (
        select(IngestionJob)
        .where(
            IngestionJob.user_id == user.id,
            IngestionJob.status.in_(["complete", "failed"]),
        )
        .order_by(desc(IngestionJob.created_at))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    jobs = result.scalars().all()

    items = []
    for job in jobs:
        result_data = job.result or {}
        items.append(
            IngestionHistoryItem(
                job_id=str(job.id),
                status=job.status,
                filename=job.filename,
                file_hash=job.file_hash,
                chat_date_start=(
                    job.chat_date_start.isoformat() if job.chat_date_start else None
                ),
                chat_date_end=(
                    job.chat_date_end.isoformat() if job.chat_date_end else None
                ),
                total_messages_in_file=job.total_messages_in_file,
                messages_new=result_data.get("messages"),
                messages_skipped=job.messages_skipped,
                total_chats=result_data.get("chats"),
                total_chunks=result_data.get("chunks"),
                ingested_at=job.created_at.isoformat(),
            )
        )

    return IngestionHistoryResponse(items=items, total=total)


@router.post("/reset")
async def reset_ingestion_data(
    db: AsyncSession = Depends(get_db),
    redis_client: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Delete ALL ingested Telegram data for the user so they can re-ingest from scratch.

    Cascade-deletes: contacts → messages, conversation_chunks, suggestions.
    Marks all past ingestion jobs as 'reset'.
    """
    # Prevent reset while an ingestion is actively running
    active_stmt = select(IngestionJob).where(
        IngestionJob.user_id == user.id,
        IngestionJob.status.in_(["processing", "paused"]),
    )
    active_result = await db.execute(active_stmt)
    if active_result.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="Cannot reset while an ingestion is running. Stop it first.",
        )

    logger.info(f"[INGEST] Full data reset requested by {user.email}")

    # Delete all contacts — cascades to messages, chunks, suggestions
    await db.execute(delete(Contact).where(Contact.user_id == user.id))

    # Mark all ingestion jobs as "reset"
    await db.execute(
        update(IngestionJob)
        .where(IngestionJob.user_id == user.id)
        .values(status="reset")
    )

    await db.commit()
    logger.info(f"[INGEST] Data reset complete for {user.email}")

    return {"status": "ok", "message": "All ingested data cleared. Ready for re-ingestion."}


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
    user_prefs = get_user_settings(user)

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

    embeddings = await embed_texts(
        chunks, input_type="document",
        user_id=user.id, operation="embedding_document",
        user_settings=user_prefs,
    )

    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        db.add(
            DocumentChunk(
                user_id=user.id,
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
    user_prefs = get_user_settings(user)

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

    embeddings = await embed_texts(
        chunks, input_type="document",
        user_id=user.id, operation="embedding_document",
        user_settings=user_prefs,
    )

    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        db.add(
            DocumentChunk(
                user_id=user.id,
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
