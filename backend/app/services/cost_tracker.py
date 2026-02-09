"""
Cost tracking service — records API usage and calculates costs.

Pricing (per 1M tokens):
- Anthropic Claude Sonnet 4: $3.00 input / $15.00 output
- OpenAI text-embedding-3-small: $0.02
- Voyage AI voyage-3-lite: $0.02
"""

import logging
import uuid
from app.database import async_session
from app.models.api_usage import ApiUsage

logger = logging.getLogger(__name__)

# ── Pricing per 1M tokens (USD) ─────────────────────────────────
# Keyed by (service, model) — input and output rates
PRICING = {
    # Anthropic Claude Sonnet 4
    ("anthropic", "claude-sonnet-4-20250514"): {
        "input": 3.00,
        "output": 15.00,
    },
    # OpenAI embeddings
    ("openai", "text-embedding-3-small"): {
        "input": 0.02,
        "output": 0.0,
    },
    # Voyage AI embeddings
    ("voyageai", "voyage-3-lite"): {
        "input": 0.02,
        "output": 0.0,
    },
}

# Fallback pricing if model not found (conservative overestimate)
FALLBACK_PRICING = {"input": 5.00, "output": 15.00}


def calculate_cost(
    service: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> float:
    """Calculate cost in USD for given token usage."""
    rates = PRICING.get((service, model), FALLBACK_PRICING)
    cost = (
        (input_tokens / 1_000_000) * rates["input"]
        + (output_tokens / 1_000_000) * rates["output"]
    )
    return round(cost, 8)  # Keep precision for small amounts


async def record_llm_usage(
    user_id: uuid.UUID,
    model: str,
    operation: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Record LLM (Anthropic) API usage. Uses its own DB session."""
    try:
        cost = calculate_cost("anthropic", model, input_tokens, output_tokens)
        async with async_session() as session:
            usage = ApiUsage(
                user_id=user_id,
                service="anthropic",
                model=model,
                operation=operation,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
            )
            session.add(usage)
            await session.commit()

        logger.debug(
            f"[COST] LLM {operation}: {input_tokens}in/{output_tokens}out "
            f"= ${cost:.6f}"
        )
    except Exception as e:
        logger.warning(f"[COST] Failed to record LLM usage: {e}")


async def record_embedding_usage(
    user_id: uuid.UUID,
    provider: str,
    model: str,
    total_tokens: int,
    operation: str,
) -> None:
    """Record embedding API usage. Uses its own DB session."""
    try:
        cost = calculate_cost(provider, model, total_tokens, 0)
        async with async_session() as session:
            usage = ApiUsage(
                user_id=user_id,
                service=provider,
                model=model,
                operation=operation,
                input_tokens=total_tokens,
                output_tokens=0,
                cost_usd=cost,
            )
            session.add(usage)
            await session.commit()

        logger.debug(
            f"[COST] Embed {operation} ({provider}): {total_tokens} tokens "
            f"= ${cost:.6f}"
        )
    except Exception as e:
        logger.warning(f"[COST] Failed to record embedding usage: {e}")
