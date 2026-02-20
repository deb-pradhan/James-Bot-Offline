---
name: Local LLM Ollama Integration
overview: Add Ollama support for local LLM inference and embeddings, with a settings UI toggle to select between local and cloud providers. Models are only shown when their provider is available (API key set or Ollama reachable). Switching embedding providers triggers a re-embed background job.
todos:
  - id: phase1-ollama-client
    content: "Phase 1: Create `backend/app/services/ollama.py` — health check, model discovery, chat, embeddings with truncation + L2-norm"
    status: completed
  - id: phase1-config
    content: "Phase 1: Add `ollama_base_url` to `backend/app/config.py` Settings class"
    status: completed
  - id: phase2-llm-routing
    content: "Phase 2: Modify `llm.py` — add `_call_ollama()`, update `_resolve_provider()`, add Ollama branch in `generate_response()`"
    status: completed
  - id: phase3-embed-routing
    content: "Phase 3: Modify `embedding.py` — add `_embed_ollama()`, add provider routing in `embed_texts()`"
    status: completed
  - id: phase4-cost-tracker
    content: "Phase 4: Modify `cost_tracker.py` — add Ollama $0 pricing, wildcard handler for `service='ollama'`"
    status: completed
  - id: phase5-settings-api
    content: "Phase 5: Settings API — new endpoints: ollama/status, available-embeddings, reembed; modify available-models to filter by keys + append Ollama"
    status: completed
  - id: phase5-preferences
    content: "Phase 5: Modify preferences endpoint — handle embedding_provider changes, requires_reembed flag, Ollama validation"
    status: pending
  - id: phase6-deps
    content: "Phase 6: Update `deps.py` — add embedding_provider/ollama defaults to get_user_settings(), update get_user_llm_model() for Ollama models"
    status: completed
  - id: phase7-frontend-types
    content: "Phase 7: Update `types/index.ts` and `lib/api.ts` — add OllamaStatus, EmbeddingProvider types, 3 new API methods"
    status: completed
  - id: phase8-settings-ui
    content: "Phase 8: Modify settings page — add Ollama status card, embedding provider selector with re-embed dialog, group LLM models by provider with conditional visibility"
    status: completed
  - id: phase9-docker
    content: "Phase 9: Add optional Ollama service to docker-compose.yml with profiles, update .env.example"
    status: completed
isProject: false
---

# Local LLM and Embeddings via Ollama

## Critical Design Decisions

**Embedding dimension compatibility**: pgvector columns are `Vector(512)`. All Ollama embeddings will be truncated to 512 dims + L2-normalized (Matryoshka technique). No schema migration needed. Recommended model: `nomic-embed-text` (native Matryoshka support).

**Embedding model switching**: Vectors from different models are incompatible even at same dimension. Switching providers requires a full re-embed of all user data. The system warns the user and runs re-embedding as a background job with progress tracking via existing WebSocket events.

**Provider routing**: LLM provider is determined by the selected model ID (checked against Ollama's model list, Anthropic prefix, or OpenAI prefix). Embedding provider is an explicit user setting (`embedding_provider`). These are independent choices.

**No new Python dependencies**: `httpx` (already in requirements.txt) is sufficient for Ollama HTTP calls.

---

## Phase 1: Ollama Service Client

### Task 1.1 — New file: [backend/app/services/ollama.py](backend/app/services/ollama.py)

Core Ollama client with health check, model discovery, chat completion, and embeddings.

```python
import httpx
import logging
import numpy as np
from app.config import get_settings

logger = logging.getLogger(__name__)

OLLAMA_TIMEOUT = 120.0  # Local models can be slow on first load
HEALTH_CACHE_TTL = 30   # seconds

async def check_health() -> bool:
    """GET {base_url}/api/tags — returns True if Ollama is reachable."""
    # Log: [OLLAMA] Health check → {base_url}
    # Error: catch httpx.ConnectError, httpx.TimeoutException
    # Log on failure: [OLLAMA] Not reachable: {error}
    # Cache result for HEALTH_CACHE_TTL seconds (module-level _health_cache)

async def list_models() -> dict:
    """GET {base_url}/api/tags → {"chat_models": [...], "embedding_models": [...]}"""
    # Parse response.models list
    # Classify: embedding models = names containing "embed", "nomic", "bge", "minilm"
    # Everything else = chat model
    # Return structured dicts with: id, name, size, family, parameter_size
    # Log: [OLLAMA] Found {n} chat models, {m} embedding models
    # Error: log + return empty lists (graceful degradation)

async def generate_chat(
    model: str, system: str, prompt: str,
    max_tokens: int = 1024, temperature: float = 0.7
) -> tuple[str, int, int]:
    """POST {base_url}/api/chat with stream=false"""
    # Returns (response_text, prompt_eval_count, eval_count)
    # Log: [OLLAMA] Chat request model={model}, prompt_len={len(prompt)}
    # Log: [OLLAMA] Chat response: {prompt_eval_count}in/{eval_count}out tokens
    # Error handling:
    #   - httpx.ConnectError → raise RuntimeError("Ollama not reachable at {url}. Start with `ollama serve`")
    #   - httpx.TimeoutException → raise RuntimeError("Ollama timed out. Model may be loading for first time.")
    #   - HTTP 404 → raise RuntimeError("Model '{model}' not found. Pull it with `ollama pull {model}`")
    #   - Other HTTP errors → raise RuntimeError("Ollama error {status}: {body}")

async def generate_embeddings(
    model: str, texts: list[str], target_dimension: int = 512
) -> tuple[list[list[float]], int]:
    """POST {base_url}/api/embed (batch). Truncate + L2-normalize to target_dimension."""
    # Returns (embeddings, approximate_token_count)
    # Batch in groups of 64 (Ollama embed endpoint accepts batch input)
    # For each vector: truncate to target_dimension, then L2-normalize
    # Log: [OLLAMA] Embedding {len(texts)} texts with {model}, truncating to {target_dimension}d
    # Log: [OLLAMA] Embeddings done: {len(result)} vectors
    # Error handling: same as generate_chat
    # Token approximation: sum(len(t.split()) * 1.3 for t in texts)
```

Key implementation detail for L2 normalization after truncation:

```python
def _truncate_and_normalize(vector: list[float], dim: int) -> list[float]:
    truncated = vector[:dim]
    norm = sum(x * x for x in truncated) ** 0.5
    if norm == 0:
        return truncated
    return [x / norm for x in truncated]
```

### Task 1.2 — Modify [backend/app/config.py](backend/app/config.py)

Add Ollama configuration to `Settings`:

```python
# After line 86 (telegram_phone)
ollama_base_url: str = "http://localhost:11434"
```

No `ollama_enabled` flag — availability is auto-detected via health check.

---

## Phase 2: LLM Provider Routing

### Task 2.1 — Modify [backend/app/services/llm.py](backend/app/services/llm.py)

**Add `_call_ollama()` function** (after `_extract_text_from_openai_response`, ~line 64):

```python
async def _call_ollama(
    model: str, system_prompt: str, user_prompt: str,
    max_tokens: int, temperature: float
) -> tuple[str, int, int]:
    """Route LLM call to local Ollama instance."""
    from app.services.ollama import generate_chat
    logger.info(f"[LLM] Routing to Ollama, model={model}")
    return await generate_chat(model, system_prompt, user_prompt, max_tokens, temperature)
```

**Modify `_resolve_provider()**` (line 39-47) — add Ollama model resolution:

```python
def _resolve_provider(model: str, user_settings: dict | None = None) -> str:
    # 1. Check static catalog first (Anthropic/OpenAI models)
    model_by_id = {m["id"]: m for m in settings.available_models}
    model_info = model_by_id.get(model, {})
    provider = model_info.get("provider")
    if provider in {"anthropic", "openai"}:
        return provider

    # 2. Check if user has this as their Ollama model
    if user_settings and user_settings.get("llm_provider") == "ollama":
        return "ollama"

    # 3. Fallback heuristics
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith("gpt"):
        return "openai"

    # 4. Assume Ollama for any unrecognized model
    return "ollama"
```

**Modify `generate_response()**` (line 72-167) — add Ollama branch in the provider routing:

After the `if provider == "anthropic":` block and the `else:` (OpenAI) block, restructure to:

```python
if provider == "anthropic":
    # ... existing Anthropic code (lines 103-114) ...
elif provider == "ollama":
    response_text, tokens_in, tokens_out = await _call_ollama(
        active_model, system_prompt, user_prompt, max_tokens, temperature
    )
else:  # openai
    # ... existing OpenAI code (lines 116-147) ...
```

Pass `user_settings` into `_resolve_provider` call at line 95.

---

## Phase 3: Embedding Provider Routing

### Task 3.1 — Modify [backend/app/services/embedding.py](backend/app/services/embedding.py)

**Add `_embed_ollama()` function** (after `_embed_voyage`, ~line 145):

```python
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
```

**Modify `embed_texts()**` (line 148-246) — add provider routing at the top of the function:

```python
async def embed_texts(texts, input_type="document", *, user_id=None, operation=None, user_settings=None):
    if not texts:
        return []

    active_settings = user_settings or {}
    embedding_provider = active_settings.get("embedding_provider", "openai")
    
    # Route to Ollama if selected
    if embedding_provider == "ollama":
        ollama_model = active_settings.get("ollama_embedding_model", "nomic-embed-text")
        logger.info(f"[EMBED] Using Ollama provider, model={ollama_model}")
        all_embeddings = []
        total_tokens = 0
        for i in range(0, len(texts), 64):  # Ollama batch size
            batch = texts[i:i+64]
            embeddings, tokens = await _embed_ollama(
                batch, input_type, model=ollama_model, dimension=settings.embedding_dimension
            )
            all_embeddings.extend(embeddings)
            total_tokens += tokens
        
        if user_id and operation:
            from app.services.cost_tracker import record_embedding_usage
            await record_embedding_usage(
                user_id=user_id, provider="ollama",
                model=ollama_model, total_tokens=total_tokens, operation=operation,
            )
        return all_embeddings

    # ... existing OpenAI/Voyage code continues unchanged ...
```

---

## Phase 4: Cost Tracking

### Task 4.1 — Modify [backend/app/services/cost_tracker.py](backend/app/services/cost_tracker.py)

**Add Ollama pricing** (after line 63, before `FALLBACK_PRICING`):

```python
# Ollama (local) — no cost, but we still track usage for visibility
("ollama", "*"): {"input": 0.0, "output": 0.0},
```

**Modify `calculate_cost()**` (line 70-82) to check Ollama wildcard:

```python
def calculate_cost(service, model, input_tokens, output_tokens):
    rates = PRICING.get((service, model))
    if rates is None and service == "ollama":
        rates = {"input": 0.0, "output": 0.0}
    if rates is None:
        rates = FALLBACK_PRICING
    cost = (input_tokens / 1_000_000) * rates["input"] + (output_tokens / 1_000_000) * rates["output"]
    return round(cost, 8)
```

---

## Phase 5: Settings API — Model Discovery and Selection

### Task 5.1 — Modify [backend/app/api/settings.py](backend/app/api/settings.py)

**New endpoint: `GET /api/settings/ollama/status**` (after `telegram_status`, ~line 169):

```python
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
```

**New endpoint: `GET /api/settings/available-embeddings**`:

```python
@router.get("/available-embeddings")
async def get_available_embeddings(user: User = Depends(get_current_user)):
    """Return available embedding providers with availability status."""
    user_settings = user.settings or {}
    
    providers = []
    
    # OpenAI
    has_openai = bool(user_settings.get("openai_api_key"))
    providers.append({
        "id": "openai", "name": "OpenAI",
        "model": "text-embedding-3-small", "available": has_openai,
        "cost": "$0.02 / 1M tokens",
    })
    
    # Voyage AI
    has_voyage = bool(user_settings.get("voyageai_api_key"))
    providers.append({
        "id": "voyageai", "name": "Voyage AI",
        "model": "voyage-4-lite", "available": has_voyage,
        "cost": "$0.02 / 1M tokens",
    })
    
    # Ollama
    from app.services.ollama import check_health, list_models
    ollama_reachable = await check_health()
    ollama_models = (await list_models())["embedding_models"] if ollama_reachable else []
    providers.append({
        "id": "ollama", "name": "Ollama (Local)",
        "model": ollama_models[0]["id"] if ollama_models else "nomic-embed-text",
        "available": ollama_reachable and len(ollama_models) > 0,
        "cost": "Free (local)",
        "models": ollama_models,
    })
    
    current_provider = user_settings.get("embedding_provider", "openai")
    current_model = user_settings.get(
        "ollama_embedding_model" if current_provider == "ollama"
        else "openai_embedding_model",
        "text-embedding-3-small"
    )
    
    return {
        "providers": providers,
        "current": {"provider": current_provider, "model": current_model},
    }
```

### Task 5.2 — Modify `GET /api/settings/available-models` (line 172-184)

Filter models by available API keys and append Ollama models:

```python
@router.get("/available-models")
async def get_available_models(user: User = Depends(get_current_user)):
    settings = get_settings()
    user_settings = user.settings or {}
    current_model = user_settings.get("llm_model", settings.anthropic_model)
    
    has_anthropic = bool(user_settings.get("anthropic_api_key"))
    has_openai = bool(user_settings.get("openai_api_key"))
    
    # Filter cloud models by available API keys
    filtered_models = []
    for m in settings.available_models:
        if m["provider"] == "anthropic" and has_anthropic:
            filtered_models.append(m)
        elif m["provider"] == "openai" and has_openai:
            filtered_models.append(m)
    
    # Append Ollama models if reachable
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
        f"{len(filtered_models)} total (anthropic={has_anthropic}, openai={has_openai})"
    )
    
    return {
        "models": filtered_models,
        "current": current_model,
        "default": settings.anthropic_model,
    }
```

### Task 5.3 — Modify `PUT /api/settings/preferences` (line 187-237)

Add handling for embedding provider changes and Ollama model validation:

- Accept new keys: `embedding_provider`, `ollama_embedding_model`, `llm_provider`
- When `embedding_provider` changes, set `requires_reembed: true` in response
- When selecting an Ollama LLM model, validate Ollama is reachable
- When selecting an Ollama embedding model, validate model exists
- Log: `[SETTINGS] Embedding provider changed from {old} to {new} for {email} — re-embed required`

### Task 5.4 — Modify `GET /api/settings/ai-status` (line 303-325)

Add Ollama status fields:

```python
# Add to return dict:
"has_ollama": ollama_reachable,
"ollama_model_count": len(ollama_chat_models),
"embedding_provider": user_settings.get("embedding_provider", "openai"),
"can_use_embeddings": has_openai_key or has_voyage_key or (ollama_reachable and ollama_has_embed_models),
```

### Task 5.5 — New endpoint: `POST /api/settings/reembed`

Triggers background re-embedding of all user chunks with the new embedding provider:

```python
@router.post("/reembed")
async def reembed_all_data(
    db: AsyncSession = Depends(get_db),
    redis_client = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    """Re-embed all conversation and document chunks with current embedding provider."""
    user_settings = get_user_settings(user)
    provider = user_settings.get("embedding_provider", "openai")
    
    logger.info(f"[SETTINGS] Re-embed requested by {user.email}, provider={provider}")
    
    # Count chunks to process
    from sqlalchemy import func, select
    from app.models.chunk import ConversationChunk, DocumentChunk
    conv_count = (await db.execute(
        select(func.count()).where(ConversationChunk.user_id == user.id)
    )).scalar() or 0
    doc_count = (await db.execute(
        select(func.count()).where(DocumentChunk.user_id == user.id)
    )).scalar() or 0
    total = conv_count + doc_count
    
    if total == 0:
        return {"status": "skipped", "message": "No chunks to re-embed"}
    
    # Launch background task
    asyncio.create_task(_reembed_user_chunks(
        user_id=user.id, user_settings=user_settings,
        redis_client=redis_client, total_chunks=total
    ))
    
    return {"status": "started", "message": f"Re-embedding {total} chunks", "total": total}
```

The `_reembed_user_chunks` background function:

- Fetches chunks in batches of 16
- Calls `embed_texts()` (which routes to the user's selected provider)
- Updates embedding column in DB
- Publishes progress via Redis `user:{user_id}:events` (reuses `ingestion_progress` event type)
- On error: logs the batch that failed, continues with next batch
- On completion: publishes `reembed_complete` event

---

## Phase 6: Dependency Injection Updates

### Task 6.1 — Modify [backend/app/api/deps.py](backend/app/api/deps.py)

**Update `get_user_settings()` defaults** (line 69-80):

```python
def get_user_settings(user: User) -> dict:
    defaults = {
        "ai_enabled": True,
        "llm_model": None,
        "llm_provider": None,           # NEW: "anthropic" | "openai" | "ollama"
        "anthropic_api_key": None,
        "openai_api_key": None,
        "voyageai_api_key": None,
        "openai_embedding_model": None,
        "voyageai_embedding_model": None,
        "embedding_provider": "openai",  # NEW: "openai" | "voyageai" | "ollama"
        "ollama_embedding_model": None,  # NEW: e.g. "nomic-embed-text"
    }
    return {**defaults, **(user.settings or {})}
```

**Update `get_user_llm_model()**` (line 58-66) — validate against Ollama models too:

```python
def get_user_llm_model(user: User) -> str | None:
    user_settings = user.settings or {}
    model = user_settings.get("llm_model")
    if model:
        valid_ids = [m["id"] for m in settings.available_models]
        if model in valid_ids:
            return model
        # Accept any model if provider is Ollama (dynamic model list)
        if user_settings.get("llm_provider") == "ollama":
            return model
    return None
```

---

## Phase 7: Frontend — Types and API Client

### Task 7.1 — Modify [frontend/src/types/index.ts](frontend/src/types/index.ts)

Add new types at the end of the file:

```typescript
// ── Ollama ──
export interface OllamaStatus {
  reachable: boolean;
  chat_models: OllamaModel[];
  embedding_models: OllamaModel[];
}

export interface OllamaModel {
  id: string;
  name: string;
  size: number;
  family: string;
  parameter_size: string;
}

// ── Embedding Provider ──
export interface EmbeddingProvider {
  id: "openai" | "voyageai" | "ollama";
  name: string;
  model: string;
  available: boolean;
  cost: string;
  models?: OllamaModel[];
}

export interface AvailableEmbeddingsResponse {
  providers: EmbeddingProvider[];
  current: { provider: string; model: string };
}

// Update existing model type to include ollama provider
export interface LLMModel {
  id: string;
  name: string;
  description: string;
  provider: "anthropic" | "openai" | "ollama";
  tier: string;
  input_cost_per_m: number;
  output_cost_per_m: number;
}
```

### Task 7.2 — Modify [frontend/src/lib/api.ts](frontend/src/lib/api.ts)

Add to the `settings` namespace (inside the `api` object, after `getAiStatus`):

```typescript
ollamaStatus: () =>
  request<OllamaStatus>("/api/settings/ollama/status"),

availableEmbeddings: () =>
  request<AvailableEmbeddingsResponse>("/api/settings/available-embeddings"),

reembed: () =>
  request<{ status: string; message: string; total?: number }>(
    "/api/settings/reembed",
    { method: "POST" }
  ),
```

Update the `availableModels` return type to use `provider: "anthropic" | "openai" | "ollama"` instead of just `"anthropic" | "openai"`.

Update the `getAiStatus` return type to include:

```typescript
has_ollama: boolean;
ollama_model_count: number;
embedding_provider: "openai" | "voyageai" | "ollama";
```

---

## Phase 8: Frontend — Settings UI

### Task 8.1 — Modify [frontend/src/app/(dashboard)/settings/page.tsx](frontend/src/app/(dashboard)/settings/page.tsx)

This is the largest frontend change. The file currently has these cards in order:

1. Telegram Connection
2. AI Kill Switch
3. API Keys
4. LLM Model Selection
5. Account
6. Danger Zone

After changes, the card order becomes:

1. Telegram Connection (unchanged)
2. AI Kill Switch (unchanged)
3. **Local AI (Ollama)** — NEW card
4. API Keys (unchanged)
5. **Embedding Provider** — NEW card
6. LLM Model Selection (MODIFIED — grouped by provider, filtered by availability)
7. Account (unchanged)
8. Danger Zone (unchanged)

**New card: Local AI (Ollama)** — inserted after AI Kill Switch card:

- Query: `useQuery({ queryKey: ["ollama-status"], queryFn: () => api.settings.ollamaStatus(), refetchInterval: 30000 })`
- Shows connection indicator (green dot if reachable, gray if not)
- Lists pulled chat model count and embedding model count
- If not reachable: shows install instructions with link to ollama.com/download
- If reachable but no models: shows `ollama pull llama3.2` and `ollama pull nomic-embed-text` commands
- Lucide icon: `Monitor` for the card header

**New card: Embedding Provider** — inserted after API Keys card:

- Query: `useQuery({ queryKey: ["available-embeddings"], queryFn: () => api.settings.availableEmbeddings() })`
- Radio-style selection (same pattern as current LLM model selector)
- Each provider row shows: name, model, cost, availability badge
- Unavailable providers are grayed out with reason ("Add OpenAI API key", "Start Ollama")
- When provider changes:
  1. Call `api.settings.updatePreferences({ embedding_provider: id })`
  2. If response includes `requires_reembed: true`, show warning dialog
  3. Dialog: "Switching embedding provider requires re-indexing all your data ({total} chunks). This runs in the background. Proceed?"
  4. On confirm: call `api.settings.reembed()`
  5. Show toast with progress
- If provider is Ollama and multiple embedding models available: show sub-selector dropdown for specific model

**Modify: LLM Model Selection card** — group by provider, filter by availability:

- Group models into sections: "Local Models (Ollama)", "Anthropic", "OpenAI"
- Only render a section if it has models (i.e., provider is available)
- Ollama section shows "Free" instead of cost
- Add `Monitor` icon for local tier (alongside existing Zap/Sparkles/Crown)
- If no models available at all, show: "No AI providers available. Add an API key above or install Ollama for local models."

---

## Phase 9: Docker Compose

### Task 9.1 — Modify [docker-compose.yml](docker-compose.yml)

Add optional Ollama service using Docker Compose profiles:

```yaml
ollama:
  image: ollama/ollama:latest
  ports:
    - "11434:11434"
  volumes:
    - ollama_data:/root/.ollama
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
    interval: 10s
    timeout: 5s
    retries: 3
  profiles: ["local-ai"]
```

Update `api` service environment:

```yaml
OLLAMA_BASE_URL: http://ollama:11434  # Only when using local-ai profile
```

Add volume:

```yaml
volumes:
  pgdata:
  ollama_data:  # NEW
```

Usage: `docker compose --profile local-ai up` includes Ollama. Default `docker compose up` does not.

### Task 9.2 — Modify [.env.example](.env.example)

Add:

```bash
# Local AI (Ollama) — optional, auto-detected
# OLLAMA_BASE_URL=http://localhost:11434
```

---

## Phase 10: Error Handling and Logging Summary

Every new code path has structured logging with `[OLLAMA]`, `[EMBED]`, `[LLM]`, or `[SETTINGS]` prefixes for grep-ability. Here is the full error matrix:

**Ollama unreachable** (`httpx.ConnectError`):

- `ollama.check_health()` → returns `False`, logged as `[OLLAMA] Not reachable`
- `ollama.generate_chat()` → raises `RuntimeError("Ollama is not reachable at {url}. Start it with 'ollama serve' or switch to a cloud provider in Settings.")`
- `ollama.generate_embeddings()` → same error message
- Frontend: caught by mutation `onError`, displayed as toast

**Ollama model not found** (HTTP 404 from Ollama):

- `ollama.generate_chat()` → raises `RuntimeError("Model '{model}' not found in Ollama. Pull it with: ollama pull {model}")`
- `ollama.generate_embeddings()` → same pattern
- Log: `[OLLAMA] Model not found: {model}` at WARNING level

**Ollama timeout** (`httpx.TimeoutException`):

- `ollama.generate_chat()` → raises `RuntimeError("Ollama request timed out after {OLLAMA_TIMEOUT}s. The model may be loading for the first time — try again.")`
- Log: `[OLLAMA] Timeout for model {model}` at WARNING level

**Ollama returns malformed response**:

- Log: `[OLLAMA] Unexpected response format: {response_body[:200]}` at ERROR level
- Raise `RuntimeError` with user-friendly message

**Embedding dimension mismatch** (Ollama model returns fewer dims than 512):

- `_truncate_and_normalize()` — if vector has fewer than 512 dims, pad with zeros then normalize
- Log: `[OLLAMA] Embedding model {model} returned {len(vec)}d, padding to 512d` at WARNING level
- This is suboptimal but prevents crashes. The warning guides users to switch to a model with >= 512 native dims.

**Re-embed failure** (partial):

- Background task catches per-batch errors, logs `[REEMBED] Batch {i} failed: {error}`, continues
- On completion: reports total successes and failures in the final event
- Log: `[REEMBED] Completed for user {email}: {success}/{total} chunks, {failures} failures`

**Provider key removed while model selected**:

- Existing validation in `PUT /preferences` already handles this (lines 216-232 of settings.py)
- Extended: same check for Ollama — if provider is "ollama" and Ollama is unreachable, reject with `HTTPException(400, "Ollama is not reachable")`

