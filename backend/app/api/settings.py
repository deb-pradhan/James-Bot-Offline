"""
Settings routes — Telegram connection (OTP flow), user preferences,
Ollama integration, embedding provider management.
"""

import asyncio
import json
import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select
from telethon import TelegramClient
from telethon.sessions import StringSession

from app.database import get_db, async_session
from app.api.deps import get_current_user, get_redis, get_user_settings
from app.models.user import User
from app.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])


class TelegramCredentials(BaseModel):
    api_id: int
    api_hash: str
    phone: str


class VerifyCodeRequest(BaseModel):
    code: str
    phone_code_hash: str | None = None


class TelegramStatusResponse(BaseModel):
    connected: bool
    phone: str | None = None
    user_id: str | None = None


# In-memory store for pending auth flows (single-instance ok for Railway)
_pending_auth: dict[str, dict] = {}


@router.post("/telegram/request-code")
async def request_telegram_code(
    creds: TelegramCredentials,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Step 1: Initiate Telegram login — sends OTP to the phone.
    """
    logger.info(f"[SETTINGS] Telegram code request for {user.email}, phone: {creds.phone}")

    try:
        client = TelegramClient(
            StringSession(), creds.api_id, creds.api_hash
        )
        await client.connect()
        result = await client.send_code_request(creds.phone)

        # Store pending client for verification step
        _pending_auth[str(user.id)] = {
            "client": client,
            "phone": creds.phone,
            "api_id": creds.api_id,
            "api_hash": creds.api_hash,
            "phone_code_hash": result.phone_code_hash,
        }

        logger.info(f"[SETTINGS] OTP sent to {creds.phone}")
        return {
            "status": "code_sent",
            "message": "Verification code sent to your Telegram app",
            "phone_code_hash": result.phone_code_hash,
        }
    except Exception as e:
        logger.error(f"[SETTINGS] Failed to send code: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to send code: {str(e)}")


@router.post("/telegram/verify-code")
async def verify_telegram_code(
    req: VerifyCodeRequest,
    db: AsyncSession = Depends(get_db),
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Step 2: Verify OTP and complete Telegram login.
    Saves session string to DB for the monitor service.
    """
    user_id_str = str(user.id)
    pending = _pending_auth.get(user_id_str)

    if not pending:
        raise HTTPException(
            status_code=400,
            detail="No pending auth flow. Call request-code first.",
        )

    client: TelegramClient = pending["client"]
    phone = pending["phone"]
    phone_code_hash = req.phone_code_hash or pending["phone_code_hash"]

    try:
        await client.sign_in(phone, req.code, phone_code_hash=phone_code_hash)
        me = await client.get_me()

        # Save session string + credentials to DB (persistent across restarts)
        session_string = client.session.save()
        user.telegram_session = session_string
        user.telegram_user_id = str(me.id)
        user.telegram_api_id = pending["api_id"]
        user.telegram_api_hash = pending["api_hash"]

        # Update user display name from Telegram profile
        tg_name = " ".join(
            filter(None, [me.first_name, me.last_name])
        ) or me.username or user.name
        user.name = tg_name

        # Store connection info in Redis for monitor (immediate pickup)
        import json
        await redis_client.set(
            f"telegram:session:{user_id_str}",
            json.dumps({
                "session_string": session_string,
                "api_id": pending["api_id"],
                "api_hash": pending["api_hash"],
            }),
        )
        await redis_client.set(f"telegram:connected:{user_id_str}", "true")
        await redis_client.publish(
            "telegram:session_updated",
            json.dumps({"user_id": user_id_str}),
        )

        await db.commit()
        await client.disconnect()
        del _pending_auth[user_id_str]

        logger.info(
            f"[SETTINGS] Telegram connected for {user.email} as {me.first_name} ({me.id})"
        )

        return {
            "status": "connected",
            "message": f"Connected as {me.first_name}",
            "telegram_user_id": str(me.id),
        }
    except Exception as e:
        logger.error(f"[SETTINGS] Verification failed: {e}")
        raise HTTPException(
            status_code=400, detail=f"Verification failed: {str(e)}"
        )


@router.get("/telegram/status", response_model=TelegramStatusResponse)
async def telegram_status(
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Check Telegram connection status."""
    connected = await redis_client.get(f"telegram:connected:{str(user.id)}")
    return TelegramStatusResponse(
        connected=connected == "true",
        phone=None,
        user_id=user.telegram_user_id,
    )


@router.get("/ollama/status")
async def ollama_status(user: User = Depends(get_current_user)):
    """Check Ollama connectivity and list available models."""
    from app.services.ollama import check_health, list_models

    reachable = await check_health()
    if not reachable:
        logger.info(f"[SETTINGS] Ollama not reachable for {user.email}")
        return {"reachable": False, "chat_models": [], "embedding_models": []}

    models = await list_models()
    logger.info(
        f"[SETTINGS] Ollama status for {user.email}: "
        f"{len(models['chat_models'])} chat, {len(models['embedding_models'])} embed"
    )
    return {"reachable": True, **models}


@router.get("/available-models")
async def get_available_models(
    user: User = Depends(get_current_user),
):
    """Return available LLM models filtered by provider availability."""
    settings = get_settings()
    user_settings = user.settings or {}
    current_model = user_settings.get("llm_model", settings.anthropic_model)

    has_anthropic = bool(user_settings.get("anthropic_api_key"))
    has_openai = bool(user_settings.get("openai_api_key"))

    filtered_models = []
    for m in settings.available_models:
        if m["provider"] == "anthropic" and has_anthropic:
            filtered_models.append(m)
        elif m["provider"] == "openai" and has_openai:
            filtered_models.append(m)

    from app.services.ollama import check_health, list_models

    if await check_health():
        ollama_models = (await list_models())["chat_models"]
        for om in ollama_models:
            filtered_models.append({
                "id": om["id"],
                "name": om["name"],
                "description": f"Local model ({om.get('parameter_size', 'unknown')})",
                "provider": "ollama",
                "tier": "local",
                "input_cost_per_m": 0.0,
                "output_cost_per_m": 0.0,
            })

    logger.info(
        f"[SETTINGS] Available models for {user.email}: "
        f"{len(filtered_models)} (anthropic={has_anthropic}, openai={has_openai})"
    )
    return {
        "models": filtered_models,
        "current": current_model,
        "default": settings.anthropic_model,
    }


@router.get("/available-embeddings")
async def get_available_embeddings(user: User = Depends(get_current_user)):
    """Return available embedding providers with availability status."""
    user_settings = user.settings or {}

    providers = []

    has_openai = bool(user_settings.get("openai_api_key"))
    providers.append({
        "id": "openai",
        "name": "OpenAI",
        "model": "text-embedding-3-small",
        "available": has_openai,
        "cost": "$0.02 / 1M tokens",
    })

    has_voyage = bool(user_settings.get("voyageai_api_key"))
    providers.append({
        "id": "voyageai",
        "name": "Voyage AI",
        "model": "voyage-4-lite",
        "available": has_voyage,
        "cost": "$0.02 / 1M tokens",
    })

    from app.services.ollama import check_health, list_models

    ollama_reachable = await check_health()
    ollama_embed_models = (
        (await list_models())["embedding_models"] if ollama_reachable else []
    )
    providers.append({
        "id": "ollama",
        "name": "Ollama (Local)",
        "model": ollama_embed_models[0]["id"] if ollama_embed_models else "nomic-embed-text",
        "available": ollama_reachable and len(ollama_embed_models) > 0,
        "cost": "Free (local)",
        "models": ollama_embed_models,
    })

    current_provider = user_settings.get("embedding_provider", "openai")
    current_model = user_settings.get("ollama_embedding_model", "text-embedding-3-small")
    if current_provider == "openai":
        current_model = user_settings.get("openai_embedding_model") or "text-embedding-3-small"
    elif current_provider == "voyageai":
        current_model = user_settings.get("voyageai_embedding_model") or "voyage-4-lite"

    return {
        "providers": providers,
        "current": {"provider": current_provider, "model": current_model},
    }


@router.put("/preferences")
async def update_preferences(
    preferences: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update user preferences/settings."""
    merged_settings = {**(user.settings or {}), **preferences}
    old_settings = user.settings or {}
    requires_reembed = False

    # ── Validate LLM model selection ──
    if "llm_model" in preferences and preferences["llm_model"]:
        model_id = preferences["llm_model"]
        model_by_id = {m["id"]: m for m in get_settings().available_models}
        model_info = model_by_id.get(model_id)

        if model_info:
            provider = model_info.get("provider")
            if provider == "anthropic" and not merged_settings.get("anthropic_api_key"):
                raise HTTPException(
                    status_code=400,
                    detail="Set an Anthropic API key before selecting a Claude model",
                )
            if provider == "openai" and not merged_settings.get("openai_api_key"):
                raise HTTPException(
                    status_code=400,
                    detail="Set an OpenAI API key before selecting an OpenAI model",
                )
        else:
            # Not in static catalog — must be an Ollama model
            ollama_provider = merged_settings.get("llm_provider", preferences.get("llm_provider"))
            if ollama_provider != "ollama":
                raise HTTPException(status_code=400, detail="Unsupported model selected")
            from app.services.ollama import check_health

            if not await check_health():
                raise HTTPException(
                    status_code=400,
                    detail="Ollama is not reachable. Start it with `ollama serve`.",
                )

    # ── Validate embedding provider change ──
    if "embedding_provider" in preferences:
        new_ep = preferences["embedding_provider"]
        old_ep = old_settings.get("embedding_provider", "openai")

        if new_ep == "ollama":
            from app.services.ollama import check_health

            if not await check_health():
                raise HTTPException(
                    status_code=400,
                    detail="Ollama is not reachable. Start it with `ollama serve`.",
                )

        if new_ep != old_ep:
            requires_reembed = True
            logger.info(
                f"[SETTINGS] Embedding provider changed from {old_ep} to {new_ep} "
                f"for {user.email} — re-embed required"
            )

    # ── Prevent removing a provider key that's required by current model ──
    if (
        ("anthropic_api_key" in preferences and preferences.get("anthropic_api_key") is None)
        or ("openai_api_key" in preferences and preferences.get("openai_api_key") is None)
    ):
        model_by_id = {m["id"]: m for m in get_settings().available_models}
        current_model = merged_settings.get("llm_model")
        current_provider = model_by_id.get(current_model, {}).get("provider")
        if current_provider == "anthropic" and not merged_settings.get("anthropic_api_key"):
            raise HTTPException(
                status_code=400,
                detail="Cannot remove Anthropic key while a Claude model is selected",
            )
        if current_provider == "openai" and not merged_settings.get("openai_api_key"):
            raise HTTPException(
                status_code=400,
                detail="Cannot remove OpenAI key while an OpenAI model is selected",
            )

    user.settings = merged_settings
    await db.commit()
    logger.info(f"[SETTINGS] Updated preferences for {user.email}")
    return {
        "status": "updated",
        "settings": user.settings,
        "requires_reembed": requires_reembed,
    }


class ValidateApiKeyRequest(BaseModel):
    api_key: str
    provider: str = "anthropic"


@router.post("/validate-api-key")
async def validate_anthropic_api_key(
    req: ValidateApiKeyRequest,
    user: User = Depends(get_current_user),
):
    """Validate a custom API key (Anthropic or OpenAI) with a minimal API call."""
    provider = (req.provider or "anthropic").lower()

    if provider == "anthropic":
        from anthropic import AsyncAnthropic, APIError

        try:
            client = AsyncAnthropic(api_key=req.api_key)
            await client.messages.create(
                model="claude-3-5-haiku-20241022",
                max_tokens=1,
                messages=[{"role": "user", "content": "Hi"}],
            )
            return {"valid": True, "message": "Anthropic API key is valid"}
        except APIError as e:
            logger.warning(f"[SETTINGS] Invalid Anthropic API key for {user.email}: {e}")
            return {"valid": False, "message": f"Invalid Anthropic API key: {e.message}"}
        except Exception as e:
            logger.error(f"[SETTINGS] Anthropic key validation error: {e}")
            return {"valid": False, "message": f"Validation failed: {str(e)}"}

    if provider == "openai":
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    "https://api.openai.com/v1/embeddings",
                    headers={
                        "Authorization": f"Bearer {req.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "text-embedding-3-small",
                        "input": ["ping"],
                        "dimensions": 8,
                    },
                )
            if response.status_code != 200:
                logger.warning(
                    f"[SETTINGS] Invalid OpenAI API key for {user.email}: "
                    f"{response.status_code} {response.text}"
                )
                return {"valid": False, "message": "Invalid OpenAI API key"}
            return {"valid": True, "message": "OpenAI API key is valid"}
        except Exception as e:
            logger.error(f"[SETTINGS] OpenAI key validation error: {e}")
            return {"valid": False, "message": f"Validation failed: {str(e)}"}

    return {
        "valid": False,
        "message": "Unsupported provider. Use 'anthropic' or 'openai'.",
    }


@router.get("/ai-status")
async def get_ai_status(
    user: User = Depends(get_current_user),
):
    """Get AI enabled status and provider-key availability."""
    user_settings = user.settings or {}
    has_anthropic_key = bool(user_settings.get("anthropic_api_key"))
    has_openai_key = bool(user_settings.get("openai_api_key"))
    has_voyage_key = bool(user_settings.get("voyageai_api_key"))
    active_model = user_settings.get("llm_model")
    model_by_id = {m["id"]: m for m in get_settings().available_models}
    active_provider = (
        model_by_id.get(active_model, {}).get("provider")
        if active_model
        else None
    )
    if not active_provider and user_settings.get("llm_provider") == "ollama":
        active_provider = "ollama"

    from app.services.ollama import check_health, list_models

    ollama_reachable = await check_health()
    ollama_embed_count = 0
    ollama_chat_count = 0
    if ollama_reachable:
        models = await list_models()
        ollama_chat_count = len(models["chat_models"])
        ollama_embed_count = len(models["embedding_models"])

    embedding_provider = user_settings.get("embedding_provider", "openai")

    return {
        "ai_enabled": user_settings.get("ai_enabled", True),
        "has_custom_api_key": has_anthropic_key or has_openai_key,
        "has_anthropic_api_key": has_anthropic_key,
        "has_openai_api_key": has_openai_key,
        "can_use_embeddings": (
            has_openai_key
            or has_voyage_key
            or (ollama_reachable and ollama_embed_count > 0)
        ),
        "active_llm_provider": active_provider,
        "has_ollama": ollama_reachable,
        "ollama_model_count": ollama_chat_count,
        "embedding_provider": embedding_provider,
    }


@router.post("/reembed")
async def reembed_all_data(
    db: AsyncSession = Depends(get_db),
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Re-embed all conversation and document chunks with the current embedding provider."""
    from app.models.chunk import ConversationChunk, DocumentChunk

    us = get_user_settings(user)
    provider = us.get("embedding_provider", "openai")
    logger.info(f"[REEMBED] Requested by {user.email}, provider={provider}")

    conv_count = (
        await db.execute(
            select(func.count()).select_from(ConversationChunk).where(
                ConversationChunk.user_id == user.id
            )
        )
    ).scalar() or 0
    doc_count = (
        await db.execute(
            select(func.count()).select_from(DocumentChunk).where(
                DocumentChunk.user_id == user.id
            )
        )
    ).scalar() or 0
    total = conv_count + doc_count

    if total == 0:
        return {"status": "skipped", "message": "No chunks to re-embed", "total": 0}

    asyncio.create_task(
        _reembed_user_chunks(
            user_id=user.id,
            user_email=user.email,
            user_settings=us,
            redis_client=redis_client,
            total_chunks=total,
        )
    )

    return {
        "status": "started",
        "message": f"Re-embedding {total} chunks in the background",
        "total": total,
    }


async def _reembed_user_chunks(
    user_id: uuid.UUID,
    user_email: str,
    user_settings: dict,
    redis_client,
    total_chunks: int,
) -> None:
    """Background task: re-embed all chunks for a user with their current provider."""
    from app.models.chunk import ConversationChunk, DocumentChunk
    from app.services.embedding import embed_texts

    BATCH = 16
    processed = 0
    failures = 0
    user_id_str = str(user_id)

    logger.info(f"[REEMBED] Starting for {user_email}: {total_chunks} chunks")

    try:
        async with async_session() as db:
            # Re-embed conversation chunks
            conv_chunks = (
                await db.execute(
                    select(ConversationChunk).where(
                        ConversationChunk.user_id == user_id
                    )
                )
            ).scalars().all()

            for i in range(0, len(conv_chunks), BATCH):
                batch = conv_chunks[i : i + BATCH]
                texts = [c.chunk_text for c in batch]
                try:
                    embeddings = await embed_texts(
                        texts,
                        input_type="document",
                        user_id=user_id,
                        operation="reembed",
                        user_settings=user_settings,
                    )
                    for chunk, emb in zip(batch, embeddings):
                        chunk.embedding = emb
                    await db.commit()
                    processed += len(batch)
                except Exception as exc:
                    failures += len(batch)
                    logger.error(f"[REEMBED] Conv batch {i} failed: {exc}")
                    await db.rollback()

                await redis_client.publish(
                    f"user:{user_id_str}:events",
                    json.dumps({
                        "type": "reembed_progress",
                        "data": {"processed": processed, "total": total_chunks, "failures": failures},
                    }),
                )

            # Re-embed document chunks
            doc_chunks = (
                await db.execute(
                    select(DocumentChunk).where(DocumentChunk.user_id == user_id)
                )
            ).scalars().all()

            for i in range(0, len(doc_chunks), BATCH):
                batch = doc_chunks[i : i + BATCH]
                texts = [c.chunk_text for c in batch]
                try:
                    embeddings = await embed_texts(
                        texts,
                        input_type="document",
                        user_id=user_id,
                        operation="reembed",
                        user_settings=user_settings,
                    )
                    for chunk, emb in zip(batch, embeddings):
                        chunk.embedding = emb
                    await db.commit()
                    processed += len(batch)
                except Exception as exc:
                    failures += len(batch)
                    logger.error(f"[REEMBED] Doc batch {i} failed: {exc}")
                    await db.rollback()

                await redis_client.publish(
                    f"user:{user_id_str}:events",
                    json.dumps({
                        "type": "reembed_progress",
                        "data": {"processed": processed, "total": total_chunks, "failures": failures},
                    }),
                )

    except Exception as exc:
        logger.error(f"[REEMBED] Fatal error for {user_email}: {exc}")

    logger.info(
        f"[REEMBED] Completed for {user_email}: "
        f"{processed}/{total_chunks} chunks, {failures} failures"
    )
    await redis_client.publish(
        f"user:{user_id_str}:events",
        json.dumps({
            "type": "reembed_complete",
            "data": {"processed": processed, "total": total_chunks, "failures": failures},
        }),
    )


class DeleteDataRequest(BaseModel):
    confirm: bool
    keep_account: bool = True


@router.delete("/delete-all-data")
async def delete_all_user_data(
    req: DeleteDataRequest,
    db: AsyncSession = Depends(get_db),
    redis_client=Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """
    Delete all user data including contacts, messages, documents, suggestions,
    ingestion jobs, API usage, and Redis keys. Optionally keeps the account.
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="Confirmation required")

    user_id_str = str(user.id)
    user_email = user.email  # Cache before any DB ops that might expire the object
    logger.info(f"[SETTINGS] Deleting all data for user {user_email}")

    try:
        from app.models.contact import Contact
        from app.models.message import Message
        from app.models.chunk import ConversationChunk, DocumentChunk
        from app.models.document import Document
        from app.models.suggestion import ResponseSuggestion
        from app.models.job import IngestionJob
        from app.models.api_usage import ApiUsage
        from sqlalchemy import delete, select

        # Bulk delete() bypasses ORM cascade, so we must delete in correct FK order:
        # Delete children before parents

        # 1. Get all contact IDs for this user (needed for child table deletes)
        contact_ids_result = await db.execute(
            select(Contact.id).where(Contact.user_id == user.id)
        )
        contact_ids = [row[0] for row in contact_ids_result.fetchall()]

        # 2. Get all document IDs for this user
        doc_ids_result = await db.execute(
            select(Document.id).where(Document.user_id == user.id)
        )
        doc_ids = [row[0] for row in doc_ids_result.fetchall()]

        # 3. Delete leaf tables (children) first
        if contact_ids:
            # Messages (child of Contact)
            await db.execute(
                delete(Message).where(Message.contact_id.in_(contact_ids))
            )
            # ConversationChunks (child of Contact)
            await db.execute(
                delete(ConversationChunk).where(ConversationChunk.contact_id.in_(contact_ids))
            )
            # Suggestions via contact (child of Contact)
            await db.execute(
                delete(ResponseSuggestion).where(ResponseSuggestion.contact_id.in_(contact_ids))
            )

        if doc_ids:
            # DocumentChunks (child of Document)
            await db.execute(
                delete(DocumentChunk).where(DocumentChunk.document_id.in_(doc_ids))
            )

        # 4. Delete parent tables
        await db.execute(delete(Contact).where(Contact.user_id == user.id))
        await db.execute(delete(Document).where(Document.user_id == user.id))

        # 5. Delete remaining user-owned records (no FK children)
        await db.execute(delete(ResponseSuggestion).where(ResponseSuggestion.user_id == user.id))
        await db.execute(delete(IngestionJob).where(IngestionJob.user_id == user.id))
        await db.execute(delete(ApiUsage).where(ApiUsage.user_id == user.id))

        # 6. Clean up Redis keys for this user
        redis_keys_to_delete = [
            f"telegram:session:{user_id_str}",
            f"telegram:connected:{user_id_str}",
            f"user:paused:{user_id_str}",
            f"user:paused_at:{user_id_str}",
        ]
        for key in redis_keys_to_delete:
            await redis_client.delete(key)

        # 7. Clear Telegram credentials from user (disconnect)
        user.telegram_session = None
        user.telegram_user_id = None
        user.telegram_api_id = None
        user.telegram_api_hash = None

        # 8. Reset user settings to defaults
        user.settings = {}

        if not req.keep_account:
            # Delete the user account entirely
            await db.delete(user)
            await db.commit()
            logger.info(f"[SETTINGS] Deleted account and all data for {user_email}")
            return {
                "status": "deleted",
                "message": "Account and all data have been permanently deleted",
            }

        await db.commit()

        # Notify connected clients that data was cleared
        import json
        await redis_client.publish(
            f"user:{user_id_str}:events",
            json.dumps({
                "type": "data_deleted",
                "message": "All your data has been deleted",
            }),
        )

        logger.info(f"[SETTINGS] Deleted all data for {user_email}, account retained")
        return {
            "status": "deleted",
            "message": "All data has been permanently deleted. Your account remains active.",
        }

    except Exception as e:
        await db.rollback()
        logger.error(f"[SETTINGS] Failed to delete data for {user_email}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete data: {str(e)}")
