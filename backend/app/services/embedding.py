"""
Embedding service — OpenAI primary, Voyage AI fallback.

OpenAI: text-embedding-3-small (512 dimensions via `dimensions` param)
Voyage: voyage-4-lite (512 dimensions natively)

Both produce 512-dim vectors to match the pgvector column.
"""

import asyncio
import logging
import uuid
import httpx
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

OPENAI_API_URL = "https://api.openai.com/v1/embeddings"
VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"
MAX_BATCH_SIZE = 128
MAX_RETRIES = 5


async def _call_with_retry(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    payload: dict,
    provider: str,
) -> httpx.Response:
    """POST with exponential backoff on 429s and 5xx errors."""
    for attempt in range(MAX_RETRIES):
        response = await client.post(url, headers=headers, json=payload)

        if response.status_code == 429 or response.status_code >= 500:
            wait = min(2 ** attempt * 5, 60)  # 5s, 10s, 20s, 40s, 60s
            reason = "rate limited (429)" if response.status_code == 429 else f"server error ({response.status_code})"
            logger.warning(
                f"[EMBED] {provider} {reason}, "
                f"waiting {wait}s (attempt {attempt + 1}/{MAX_RETRIES})"
            )
            await asyncio.sleep(wait)
            continue

        return response

    # Return last failed response so caller can handle fallback
    return response  # type: ignore[possibly-undefined]


async def _embed_openai(
    texts: list[str],
    input_type: str,
    *,
    api_key: str | None,
    model: str,
) -> tuple[list[list[float]], int] | None:
    """Try OpenAI embeddings. Returns (embeddings, token_count) or None on failure."""
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await _call_with_retry(
                client,
                OPENAI_API_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                payload={
                    "model": model,
                    "input": texts,
                    "dimensions": settings.embedding_dimension,
                    "encoding_format": "float",
                },
                provider="OpenAI",
            )

            if response.status_code != 200:
                logger.warning(
                    f"[EMBED] OpenAI failed ({response.status_code}), "
                    f"falling back to Voyage AI"
                )
                return None

            data = response.json()
            embeddings = [item["embedding"] for item in data["data"]]
            tokens = data.get("usage", {}).get("total_tokens", 0)
            if isinstance(tokens, str):
                tokens = 0
            logger.info(f"[EMBED] OpenAI batch done, tokens: {tokens}")
            return embeddings, tokens

    except Exception as e:
        logger.warning(f"[EMBED] OpenAI error: {e}, falling back to Voyage AI")
        return None


async def _embed_voyage(
    texts: list[str],
    input_type: str,
    *,
    api_key: str | None,
    model: str,
) -> tuple[list[list[float]], int]:
    """Voyage AI embeddings (fallback). Returns (embeddings, token_count). Raises on failure."""
    if not api_key:
        raise RuntimeError(
            "No embedding provider available: "
            "both OpenAI and Voyage API keys are missing in user settings"
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await _call_with_retry(
            client,
            VOYAGE_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            payload={
                "model": model,
                "input": texts,
                "input_type": input_type,
            },
            provider="Voyage",
        )

        if response.status_code != 200:
            logger.error(
                f"[EMBED] Voyage AI failed: {response.status_code} - {response.text}"
            )
            raise RuntimeError(
                f"Voyage AI embedding failed: {response.status_code}"
            )

        data = response.json()
        embeddings = [item["embedding"] for item in data["data"]]
        tokens = data.get("usage", {}).get("total_tokens", 0)
        if isinstance(tokens, str):
            tokens = 0
        logger.info(f"[EMBED] Voyage batch done, tokens: {tokens}")
        return embeddings, tokens


async def _embed_ollama(
    texts: list[str],
    input_type: str,
    *,
    model: str,
    dimension: int = 512,
) -> tuple[list[list[float]], int]:
    """Ollama local embeddings. Truncates + L2-normalizes to target dimension."""
    from app.services.ollama import generate_embeddings

    logger.info(f"[EMBED] Routing to Ollama, model={model}, dim={dimension}")
    return await generate_embeddings(model, texts, target_dimension=dimension)


async def embed_texts(
    texts: list[str],
    input_type: str = "document",
    *,
    user_id: uuid.UUID | None = None,
    operation: str | None = None,
    user_settings: dict | None = None,
) -> list[list[float]]:
    """
    Embed texts using the user's selected provider.

    Provider priority: user setting → OpenAI (primary) → Voyage AI (fallback).

    Args:
        texts: List of strings to embed
        input_type: "document" for stored content, "query" for search queries
        user_id: If provided with operation, records cost to api_usage table
        operation: Operation label for cost tracking

    Returns:
        List of embedding vectors (512 dimensions each)
    """
    if not texts:
        return []

    active_settings = user_settings or {}
    embedding_provider = active_settings.get("embedding_provider", "openai")

    # ── Ollama local embeddings ──
    if embedding_provider == "ollama":
        ollama_model = active_settings.get("ollama_embedding_model") or "nomic-embed-text"
        logger.info(f"[EMBED] Using Ollama provider, model={ollama_model}")
        all_embeddings: list[list[float]] = []
        total_tokens = 0
        for i in range(0, len(texts), 64):
            batch = texts[i : i + 64]
            embeddings, tokens = await _embed_ollama(
                batch, input_type,
                model=ollama_model,
                dimension=settings.embedding_dimension,
            )
            all_embeddings.extend(embeddings)
            total_tokens += tokens

        if user_id and operation:
            from app.services.cost_tracker import record_embedding_usage

            await record_embedding_usage(
                user_id=user_id,
                provider="ollama",
                model=ollama_model,
                total_tokens=total_tokens,
                operation=operation,
            )
        return all_embeddings

    # ── Cloud embeddings (OpenAI primary, Voyage fallback) ──
    openai_key = active_settings.get("openai_api_key")
    voyage_key = active_settings.get("voyageai_api_key")
    openai_model = (
        active_settings.get("openai_embedding_model")
        or settings.openai_embedding_model
    )
    voyage_model = (
        active_settings.get("voyageai_embedding_model")
        or settings.voyageai_embedding_model
    )

    if not openai_key and not voyage_key:
        raise ValueError(
            "No embedding API key configured for this user. "
            "Set `openai_api_key` (or `voyageai_api_key`) in settings, "
            "or select Ollama for local embeddings."
        )

    all_embeddings: list[list[float]] = []
    openai_tokens = 0
    voyage_tokens = 0

    for i in range(0, len(texts), MAX_BATCH_SIZE):
        batch = texts[i : i + MAX_BATCH_SIZE]
        batch_num = i // MAX_BATCH_SIZE + 1
        logger.info(
            f"[EMBED] Batch {batch_num}, size={len(batch)}, type={input_type}"
        )

        # Try OpenAI first
        openai_result = await _embed_openai(
            batch,
            input_type,
            api_key=openai_key,
            model=openai_model,
        )

        if openai_result is not None:
            embeddings, tokens = openai_result
            openai_tokens += tokens
            all_embeddings.extend(embeddings)
        else:
            # Fall back to Voyage AI
            embeddings, tokens = await _embed_voyage(
                batch,
                input_type,
                api_key=voyage_key,
                model=voyage_model,
            )
            voyage_tokens += tokens
            all_embeddings.extend(embeddings)

    logger.info(f"[EMBED] Total embeddings generated: {len(all_embeddings)}")

    # Record cost if caller provided tracking context
    if user_id and operation:
        from app.services.cost_tracker import record_embedding_usage

        if openai_tokens > 0:
            await record_embedding_usage(
                user_id=user_id,
                provider="openai",
                model=openai_model,
                total_tokens=openai_tokens,
                operation=operation,
            )
        if voyage_tokens > 0:
            await record_embedding_usage(
                user_id=user_id,
                provider="voyageai",
                model=voyage_model,
                total_tokens=voyage_tokens,
                operation=operation,
            )

    return all_embeddings


async def embed_query(
    text: str,
    *,
    user_id: uuid.UUID | None = None,
    operation: str | None = None,
    user_settings: dict | None = None,
) -> list[float]:
    """Embed a single query text for similarity search."""
    results = await embed_texts(
        [text],
        input_type="query",
        user_id=user_id,
        operation=operation,
        user_settings=user_settings,
    )
    return results[0]
