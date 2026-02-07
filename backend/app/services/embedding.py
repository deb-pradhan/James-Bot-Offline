"""
Embedding service using Voyage AI API.

Uses voyage-3-lite (512 dimensions) for cost-efficient embeddings.
Calls the API directly via httpx for full async control.
"""

import logging
import httpx
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"
MAX_BATCH_SIZE = 128  # Voyage AI batch limit


async def embed_texts(
    texts: list[str],
    input_type: str = "document",
) -> list[list[float]]:
    """
    Embed a list of texts using Voyage AI.

    Args:
        texts: List of strings to embed
        input_type: "document" for stored content, "query" for search queries

    Returns:
        List of embedding vectors (each is a list of floats)
    """
    if not texts:
        return []

    if not settings.voyageai_api_key:
        raise ValueError("VOYAGEAI_API_KEY not configured")

    all_embeddings: list[list[float]] = []

    # Process in batches
    for i in range(0, len(texts), MAX_BATCH_SIZE):
        batch = texts[i : i + MAX_BATCH_SIZE]
        logger.info(
            f"[EMBED] Embedding batch {i // MAX_BATCH_SIZE + 1}, "
            f"size={len(batch)}, type={input_type}"
        )

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                VOYAGE_API_URL,
                headers={
                    "Authorization": f"Bearer {settings.voyageai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings.embedding_model,
                    "input": batch,
                    "input_type": input_type,
                },
            )

            if response.status_code != 200:
                logger.error(
                    f"[EMBED] Voyage AI API error: {response.status_code} - {response.text}"
                )
                raise RuntimeError(
                    f"Voyage AI embedding failed: {response.status_code}"
                )

            data = response.json()
            batch_embeddings = [item["embedding"] for item in data["data"]]
            all_embeddings.extend(batch_embeddings)

            tokens_used = data.get("usage", {}).get("total_tokens", "?")
            logger.info(f"[EMBED] Batch complete, tokens used: {tokens_used}")

    logger.info(f"[EMBED] Total embeddings generated: {len(all_embeddings)}")
    return all_embeddings


async def embed_query(text: str) -> list[float]:
    """Embed a single query text for similarity search."""
    results = await embed_texts([text], input_type="query")
    return results[0]
