"""
Ollama client for local LLM inference and embeddings.

Provides health check, model discovery, chat completion, and batch embeddings.
Embeddings are truncated + L2-normalized to match the pgvector Vector(512) column.
"""

import logging
import math
import time
import httpx
from app.config import get_settings

logger = logging.getLogger(__name__)

EMBED_BATCH_SIZE = 64
HEALTH_CACHE_TTL = 30

EMBEDDING_MODEL_KEYWORDS = {"embed", "nomic", "bge", "minilm", "snowflake", "gte", "e5"}

_health_cache: dict[str, tuple[bool, float]] = {}
_models_cache: dict[str, tuple[dict, float]] = {}


def _get_base_url() -> str:
    return get_settings().ollama_base_url.rstrip("/")


def _get_timeout() -> float:
    timeout = float(get_settings().ollama_timeout_seconds)
    # Guard against broken env values.
    return timeout if timeout > 0 else 300.0


def _get_keep_alive() -> str:
    return get_settings().ollama_keep_alive


def _truncate_and_normalize(vector: list[float], dim: int) -> list[float]:
    """Truncate to dim dimensions, pad if shorter, then L2-normalize (Matryoshka technique)."""
    if len(vector) < dim:
        logger.warning(
            f"[OLLAMA] Vector has {len(vector)}d, padding to {dim}d"
        )
        vector = vector + [0.0] * (dim - len(vector))
    truncated = vector[:dim]
    norm = math.sqrt(sum(x * x for x in truncated))
    if norm == 0:
        return truncated
    return [x / norm for x in truncated]


def _is_embedding_model(model_name: str) -> bool:
    lower = model_name.lower()
    return any(kw in lower for kw in EMBEDDING_MODEL_KEYWORDS)


def _parse_model_entry(m: dict) -> dict:
    name = m.get("name", m.get("model", ""))
    details = m.get("details", {})
    return {
        "id": name,
        "name": name.split(":")[0] if ":" in name else name,
        "size": m.get("size", 0),
        "family": details.get("family", "unknown"),
        "parameter_size": details.get("parameter_size", "unknown"),
        "quantization_level": details.get("quantization_level", ""),
    }


async def check_health() -> bool:
    """Return True if Ollama is reachable. Cached for HEALTH_CACHE_TTL seconds."""
    base_url = _get_base_url()
    now = time.monotonic()

    cached = _health_cache.get(base_url)
    if cached and (now - cached[1]) < HEALTH_CACHE_TTL:
        return cached[0]

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/api/tags")
            healthy = resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        logger.info(f"[OLLAMA] Not reachable at {base_url}: {exc.__class__.__name__}")
        healthy = False
    except Exception as exc:
        logger.warning(f"[OLLAMA] Health check error: {exc}")
        healthy = False

    _health_cache[base_url] = (healthy, now)
    if healthy:
        logger.debug(f"[OLLAMA] Health check OK at {base_url}")
    return healthy


async def list_models() -> dict:
    """Discover available Ollama models, classified as chat or embedding.

    Returns {"chat_models": [...], "embedding_models": [...]}.
    Results cached for HEALTH_CACHE_TTL seconds.
    """
    base_url = _get_base_url()
    now = time.monotonic()

    cached = _models_cache.get(base_url)
    if cached and (now - cached[1]) < HEALTH_CACHE_TTL:
        return cached[0]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{base_url}/api/tags")
            resp.raise_for_status()

        raw_models = resp.json().get("models", [])
        chat_models = []
        embedding_models = []

        for m in raw_models:
            parsed = _parse_model_entry(m)
            if _is_embedding_model(parsed["id"]):
                embedding_models.append(parsed)
            else:
                chat_models.append(parsed)

        result = {"chat_models": chat_models, "embedding_models": embedding_models}
        logger.info(
            f"[OLLAMA] Found {len(chat_models)} chat models, "
            f"{len(embedding_models)} embedding models"
        )
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.info(f"[OLLAMA] Not reachable while listing models")
        result = {"chat_models": [], "embedding_models": []}
    except Exception as exc:
        logger.warning(f"[OLLAMA] Failed to list models: {exc}")
        result = {"chat_models": [], "embedding_models": []}

    _models_cache[base_url] = (result, now)
    return result


async def generate_chat(
    model: str,
    system: str,
    prompt: str,
    max_tokens: int = 1024,
    temperature: float = 0.7,
) -> tuple[str, int, int]:
    """Send a chat completion request to Ollama.

    Returns (response_text, input_token_count, output_token_count).
    """
    base_url = _get_base_url()
    timeout_seconds = _get_timeout()
    keep_alive = _get_keep_alive()
    logger.info(f"[OLLAMA] Chat request model={model}, prompt_len={len(prompt)}")

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            resp = await client.post(f"{base_url}/api/chat", json=payload)
    except httpx.ConnectError:
        raise RuntimeError(
            f"Ollama is not reachable at {base_url}. "
            "Start it with `ollama serve` or switch to a cloud provider in Settings."
        )
    except httpx.TimeoutException:
        logger.warning(
            f"[OLLAMA] Timeout for model {model} after {timeout_seconds}s "
            f"(keep_alive={keep_alive})"
        )
        raise RuntimeError(
            f"Ollama request timed out after {timeout_seconds}s. "
            "The model may be loading for the first time — try again."
        )

    if resp.status_code == 404:
        logger.warning(f"[OLLAMA] Model not found: {model}")
        raise RuntimeError(
            f"Model '{model}' not found in Ollama. "
            f"Pull it with: ollama pull {model}"
        )
    if resp.status_code != 200:
        body = resp.text[:300]
        logger.error(f"[OLLAMA] Chat error {resp.status_code}: {body}")
        raise RuntimeError(f"Ollama error {resp.status_code}: {body}")

    data = resp.json()
    message = data.get("message", {})
    text = message.get("content", "").strip()
    if not text:
        logger.error(f"[OLLAMA] Unexpected response format: {str(data)[:200]}")
        raise RuntimeError("Ollama returned an empty response")

    tokens_in = data.get("prompt_eval_count", 0) or 0
    tokens_out = data.get("eval_count", 0) or 0

    logger.info(f"[OLLAMA] Chat response: {tokens_in}in/{tokens_out}out tokens")
    return text, tokens_in, tokens_out


async def generate_embeddings(
    model: str,
    texts: list[str],
    target_dimension: int = 512,
) -> tuple[list[list[float]], int]:
    """Generate embeddings via Ollama, truncated + L2-normalized to target_dimension.

    Returns (list_of_vectors, approximate_token_count).
    """
    base_url = _get_base_url()
    timeout_seconds = _get_timeout()
    keep_alive = _get_keep_alive()
    if not texts:
        return [], 0

    logger.info(
        f"[OLLAMA] Embedding {len(texts)} texts with {model}, "
        f"target={target_dimension}d"
    )

    all_embeddings: list[list[float]] = []
    total_tokens = 0

    for batch_start in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[batch_start : batch_start + EMBED_BATCH_SIZE]

        try:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                resp = await client.post(
                    f"{base_url}/api/embed",
                    json={"model": model, "input": batch, "keep_alive": keep_alive},
                )
        except httpx.ConnectError:
            raise RuntimeError(
                f"Ollama is not reachable at {base_url}. "
                "Start it with `ollama serve` or switch to a cloud provider in Settings."
            )
        except httpx.TimeoutException:
            logger.warning(f"[OLLAMA] Embedding timeout for model {model}")
            raise RuntimeError(
            f"Ollama embedding timed out after {timeout_seconds}s. Try again."
            )

        if resp.status_code == 404:
            logger.warning(f"[OLLAMA] Embedding model not found: {model}")
            raise RuntimeError(
                f"Model '{model}' not found in Ollama. "
                f"Pull it with: ollama pull {model}"
            )
        if resp.status_code != 200:
            body = resp.text[:300]
            logger.error(f"[OLLAMA] Embedding error {resp.status_code}: {body}")
            raise RuntimeError(f"Ollama embedding error {resp.status_code}: {body}")

        data = resp.json()
        raw_embeddings = data.get("embeddings", [])
        if not raw_embeddings:
            logger.error(f"[OLLAMA] No embeddings returned: {str(data)[:200]}")
            raise RuntimeError("Ollama returned no embeddings")

        for vec in raw_embeddings:
            all_embeddings.append(_truncate_and_normalize(vec, target_dimension))

        batch_tokens = int(sum(len(t.split()) * 1.3 for t in batch))
        total_tokens += batch_tokens

    logger.info(f"[OLLAMA] Embeddings done: {len(all_embeddings)} vectors")
    return all_embeddings, total_tokens
