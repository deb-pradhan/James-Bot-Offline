# James Bot — System Architecture

> **Purpose**: Authoritative technical reference for developers and AI agents onboarding to this project. Read this before touching any code.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Technology Stack](#3-technology-stack)
4. [Services Overview](#4-services-overview)
5. [Infrastructure & Configuration](#5-infrastructure--configuration)
6. [Backend Deep-Dive](#6-backend-deep-dive)
7. [Monitor Service Deep-Dive](#7-monitor-service-deep-dive)
8. [Frontend Deep-Dive](#8-frontend-deep-dive)
9. [Database Schema](#9-database-schema)
10. [Redis Channel Map](#10-redis-channel-map)
11. [Data Flow Diagrams](#11-data-flow-diagrams)
12. [API Reference](#12-api-reference)
13. [Authentication & Multi-Tenancy](#13-authentication--multi-tenancy)
14. [Deployment (Railway)](#14-deployment-railway)
15. [Local Development](#15-local-development)
16. [Known Issues & Active Work](#16-known-issues--active-work)
17. [Naming Conventions & Patterns](#17-naming-conventions--patterns)

---

## 1. Project Overview

**James Bot** is a multi-tenant Telegram reply assistant. It monitors a user's Telegram account in real-time, ingests conversation history, and uses an LLM (Claude, GPT-4.1, or local Ollama models) with RAG (retrieval-augmented generation) to ghostwrite replies that match the user's writing style.

### Core User Journey

1. User registers → connects their Telegram account via OTP (Telethon userbot)
2. User uploads a Telegram JSON export to ingest historical conversations
3. The system embeds conversations into pgvector for semantic retrieval
4. As new Telegram messages arrive live, the system auto-generates draft replies
5. User reviews/approves/edits suggested replies from the web dashboard
6. Approved replies are sent back to Telegram via the userbot

### Key Capabilities

- **Real-time monitoring**: Telethon userbot captures incoming/outgoing Telegram messages instantly
- **RAG ghostwriting**: Retrieves semantically similar past conversations + documents to inform reply generation
- **Style analysis**: Claude analyzes the user's writing style per contact, stored as a prose profile
- **Multi-user isolation**: Each user's data, embeddings, Redis channels, and Telegram session are fully isolated
- **Scope-aware queries**: AI queries can be scoped to all chats, DMs only, groups only, specific contacts, or Telegram folder groups
- **Local AI mode**: Users can run LLM + embeddings fully local via Ollama (offline-ish processing, no cloud API cost for local operations)
- **Cost tracking**: Every LLM and embedding API call is logged with token counts and USD cost

---

## 2. Repository Structure

```
TG-reply-bot/
├── backend/                    # FastAPI service (Python)
│   ├── Dockerfile
│   ├── railway.toml
│   ├── requirements.txt
│   ├── entrypoint.sh           # alembic upgrade head → uvicorn
│   ├── alembic/
│   │   ├── env.py
│   │   └── versions/           # 6 migration files (001–005)
│   └── app/
│       ├── main.py             # FastAPI app, lifespan, CORS middleware
│       ├── config.py           # Settings (pydantic-settings)
│       ├── database.py         # SQLAlchemy async engine + pgvector init
│       ├── api/                # Route handlers (one file per domain)
│       │   ├── router.py       # Aggregates all sub-routers
│       │   ├── auth.py         # /api/auth/*
│       │   ├── chat.py         # /api/chat/*
│       │   ├── contacts.py     # /api/contacts/*
│       │   ├── dashboard.py    # /api/dashboard/*
│       │   ├── deps.py         # DI: get_current_user, get_redis, etc.
│       │   ├── documents.py    # /api/documents/*
│       │   ├── ingest.py       # /api/ingest/*
│       │   ├── settings.py     # /api/settings/*
│       │   ├── suggestions.py  # /api/suggestions/*
│       │   └── ws.py           # /ws WebSocket endpoint
│       ├── models/             # SQLAlchemy ORM models
│       │   ├── user.py
│       │   ├── contact.py
│       │   ├── message.py
│       │   ├── chunk.py        # ConversationChunk + DocumentChunk
│       │   ├── suggestion.py
│       │   ├── document.py
│       │   ├── job.py          # IngestionJob
│       │   └── api_usage.py
│       ├── schemas/            # Pydantic request/response models
│       │   ├── auth.py, chat.py, contact.py, dashboard.py
│       │   ├── document.py, ingest.py, suggestion.py, ws.py
│       ├── services/           # Business logic
│       │   ├── llm.py          # LLM abstraction + prompt templates
│       │   ├── response_generator.py  # Full RAG pipeline
│       │   ├── retrieval.py    # pgvector similarity search
│       │   ├── embedding.py    # OpenAI/Voyage/Ollama embedding routing
│       │   ├── ollama.py       # Ollama client (health/models/chat/embed)
│       │   ├── ingestion.py    # 5-step ingest pipeline
│       │   ├── message_consumer.py   # Redis subscriber → process live messages
│       │   ├── style_analyzer.py     # Per-contact style profile generation
│       │   ├── cost_tracker.py       # Token cost recording
│       │   └── document_parser.py    # PDF/DOCX/TXT/MD/URL → text + chunks
│       └── utils/
│           ├── auth.py         # bcrypt hashing + JWT
│           ├── email.py        # SMTP password reset
│           └── telegram_export.py    # Telegram JSON export parser
│
├── monitor/                    # Telethon userbot service (Python)
│   ├── Dockerfile
│   ├── railway.toml
│   ├── requirements.txt
│   └── app/
│       ├── main.py             # Multi-user session manager + entry point
│       ├── config.py           # MonitorSettings
│       ├── relay.py            # RedisRelay (pub/sub abstraction)
│       ├── handlers.py         # Telethon event handlers
│       └── sync.py             # Initial sync (top 200 dialogs)
│
├── frontend/                   # Next.js 16 dashboard (TypeScript)
│   ├── Dockerfile              # Multi-stage: node builder → runner
│   ├── railway.toml
│   ├── package.json
│   ├── next.config.ts
│   ├── components.json         # shadcn/ui config
│   └── src/
│       ├── app/
│       │   ├── layout.tsx      # Root layout: fonts, dark theme, Providers
│       │   ├── login/page.tsx
│       │   ├── forgot-password/page.tsx
│       │   ├── reset-password/page.tsx
│       │   └── (dashboard)/    # Auth-guarded route group
│       │       ├── layout.tsx  # Auth guard + sidebar + status bar
│       │       ├── page.tsx    # Overview / dashboard home
│       │       ├── inbox/
│       │       │   ├── page.tsx           # Contact list
│       │       │   └── [contactId]/page.tsx  # Conversation + composer
│       │       ├── ingest/page.tsx
│       │       ├── knowledge/page.tsx
│       │       ├── settings/page.tsx
│       │       └── costs/page.tsx
│       ├── components/
│       │   ├── layout/         # sidebar, status-bar, providers
│       │   ├── inbox/          # query-panel (AI chat assistant)
│       │   └── ui/             # shadcn/ui primitives
│       ├── hooks/
│       │   ├── use-auth.ts
│       │   ├── use-websocket.ts
│       │   └── use-preferences.ts
│       ├── lib/
│       │   ├── api.ts          # Typed API client
│       │   └── utils.ts
│       └── types/index.ts      # All TypeScript interfaces
│
├── scripts/
│   └── generate_session.py     # One-time Telethon session string generator
│
├── docs/
│   ├── ARCHITECTURE.md         # This file
│   ├── REFACTORING_PLAN.md     # Feb 2026 code quality audit
│   ├── USER_SETUP_GUIDE.md
│   └── RAILWAY_DEPLOY.md
│
├── .cursor/plans/              # AI agent task plans
│   ├── multi-tenant_user_isolation_1e8a4c3e.plan.md  # COMPLETED
│   ├── ingestion_ux_overhaul_461ebb94.plan.md
│   └── railway-hosting-runbook_4ac46f51.plan.md
│
├── .env.example                # Required env vars with descriptions
├── docker-compose.yml          # 6-service local stack (optional Ollama profile)
└── README.md
```

---

## 3. Technology Stack

### Backend
| Component | Technology | Notes |
|-----------|-----------|-------|
| Framework | FastAPI 0.115 | Async, with lifespan context manager |
| ORM | SQLAlchemy 2.0 async | asyncpg driver |
| Database | PostgreSQL 16 + pgvector | Vector similarity via `<=>` cosine operator |
| Migrations | Alembic | Run at startup via `entrypoint.sh` |
| Cache / Pub-Sub | Redis 7 (hiredis) | Sessions, pub/sub, pause flags |
| LLM – cloud primary | Anthropic Claude | Default cloud model: `claude-sonnet-4-20250514` |
| LLM – cloud secondary | OpenAI GPT-4.1 | User-selectable in settings |
| LLM – local | Ollama (`llama3.2`, `gemma3:4b`, etc.) | Dynamically discovered from `/api/tags` |
| Embeddings – cloud primary | OpenAI `text-embedding-3-small` | 512 dimensions |
| Embeddings – cloud fallback | Voyage AI `voyage-4-lite` | 512 dimensions |
| Embeddings – local | Ollama (`nomic-embed-text`, etc.) | Truncate/pad + L2 normalize to 512d |
| Auth | bcrypt + python-jose JWT | ⚠ python-jose has CVEs, planned replacement with PyJWT |
| Email | smtplib (blocking) | Password reset only; ⚠ blocking in async context |
| Telegram parsing | telethon (in utils) | JSON export parser only |

### Monitor
| Component | Technology |
|-----------|-----------|
| Telegram client | Telethon 1.37 (`StringSession`) |
| Redis | redis[hiredis] 5.2 |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | Next.js 16.1 App Router |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Components | shadcn/ui + Radix UI |
| Data fetching | TanStack React Query 5 |
| HTTP client | Fetch API (wrapped in `lib/api.ts`) |
| Real-time | WebSocket (native browser) |
| Markdown | react-markdown + remark-gfm |
| Fonts | Geist Sans + Geist Mono |

---

## 4. Services Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Railway / Docker                            │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────────┐  │
│  │ Frontend │───▶│   Backend    │◀──▶│  PostgreSQL + pgvector  │  │
│  │ Next.js  │    │   FastAPI    │    └─────────────────────────┘  │
│  │ :3000    │    │   :8000      │                                  │
│  └──────────┘    └──────┬───────┘    ┌─────────────────────────┐  │
│       │ WS             │◀──────────▶│         Redis            │  │
│       └────────────────▶            └───────────┬─────────────┘  │
│                                                 │                  │
│                         ┌───────────────────────┘                  │
│                         ▼                                           │
│                  ┌──────────────┐                                   │
│                  │   Monitor    │◀──▶ Telegram API                  │
│                  │   Telethon   │                                   │
│                  └──────────────┘                                   │
└─────────────────────────────────────────────────────────────────────┘
```

| Service | Role | Port |
|---------|------|------|
| `api` (backend) | REST API, WebSocket server, background task runner | 8000 |
| `monitor` | Telegram userbot — listens for messages, sends drafts | none |
| `web` (frontend) | Next.js dashboard | 3000 |
| `postgres` | Primary database with pgvector extension | 5432 |
| `redis` | Pub/sub broker, session store, pause flags, cache | 6379 |
| `ollama` (optional) | Local LLM + embedding runtime (profile `local-ai`) | 11434 |

**Communication paths:**
- Frontend → Backend: HTTP REST (`/api/*`) + WebSocket (`/ws`)
- Backend → Frontend: WebSocket push via Redis pub/sub
- Monitor → Backend: Redis pub/sub (`telegram:new_messages:{user_id}`)
- Backend → Monitor: Redis pub/sub (`telegram:send_commands:{user_id}`, `telegram:session_updated`)
- Backend ↔ PostgreSQL: SQLAlchemy async (asyncpg)
- Backend ↔ Redis: redis-py async
- Monitor ↔ Redis: redis-py async
- Monitor ↔ Telegram: Telethon MTProto

---

## 5. Infrastructure & Configuration

### Environment Variables

All vars are defined in `.env.example`. Mandatory vars (without these the app will not start):

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Cache / Pub-Sub
REDIS_URL=redis://host:6379

# LLM / embeddings — cloud keys optional if using Ollama local mode
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...           # optional, enables GPT-4 models
VOYAGEAI_API_KEY=pa-...         # optional, fallback embeddings
OLLAMA_BASE_URL=http://localhost:11434   # optional (auto-detected in UI)

# Auth
JWT_SECRET=<random 32+ char string>

# CORS / URLs
CORS_ORIGINS=https://your-app.railway.app
FRONTEND_URL=https://your-app.railway.app

# Frontend (baked in at build time — requires rebuild to change)
NEXT_PUBLIC_API_URL=https://api.your-app.railway.app
NEXT_PUBLIC_WS_URL=wss://api.your-app.railway.app

# Telegram — required ONLY if running monitor in single-user mode
TELEGRAM_SESSION_STRING=...
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...

# SMTP — required only for password reset emails
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
FROM_EMAIL=...
```

### docker-compose.yml (local development)

Six services (one optional):
- `postgres`: `pgvector/pgvector:pg16`, port 5432, persistent volume
- `redis`: `redis:7-alpine`, port 6379
- `api`: builds `backend/`, port 8000, mounts `.env`, reaches host Ollama via `host.docker.internal`
- `monitor`: builds `monitor/`, no exposed port, mounts `.env`
- `web`: builds `frontend/`, port 3000, receives `NEXT_PUBLIC_*` as build args
- `ollama` (optional): `ollama/ollama`, profile `local-ai`, port 11434

### Railway Deployment

Each of `backend/`, `monitor/`, and `frontend/` has its own `railway.toml`:

```toml
# backend/railway.toml
[deploy]
builder = "dockerfile"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` are Next.js build-time constants — **changing them requires a full frontend rebuild/redeploy**.

---

## 6. Backend Deep-Dive

### Application Startup (`app/main.py`)

The `lifespan` async context manager runs on startup:
1. Creates database engine, runs `init_db()` (creates pgvector extension)
2. Runs Alembic migrations via `subprocess.run` (blocking call — see known issues)
3. Scans database for all users with Telegram sessions → writes each session to Redis key `telegram:session:{user_id}` → publishes `telegram:session_updated` so Monitor can pick them up
4. Starts `message_consumer.start()` as a background asyncio task

**CORS**: Custom `FlexibleCORSMiddleware` dynamically allows:
- Any `*.railway.app` or `*.up.railway.app` origin
- `CORS_ORIGINS` env var value
- All `localhost:*` variants

### Config (`app/config.py`)

`Settings` inherits from `pydantic_settings.BaseSettings`. Key properties:

```python
# Computed property — converts postgresql:// → postgresql+asyncpg://
settings.async_database_url

# Available LLM models
settings.available_models = [
    "claude-3-5-haiku-20241022",
    "claude-sonnet-4-20250514",   # default
    "claude-opus-4-20250514",
    "gpt-4.1-mini",
    "gpt-4.1"
]

# Ollama runtime
settings.ollama_base_url
settings.ollama_timeout_seconds
settings.ollama_keep_alive
```

### Database (`app/database.py`)

- `AsyncEngine` with `pool_size=20`, `max_overflow=10`
- SSL **disabled** for `.railway.internal` hostnames (Railway's private network causes asyncpg SSL negotiation to hang)
- `get_async_session()` → async generator yielding `AsyncSession` (used in DI)
- `init_db()` runs `CREATE EXTENSION IF NOT EXISTS vector` via raw connection

### Dependency Injection (`api/deps.py`)

FastAPI dependencies injected into route handlers:

| Dependency | Returns | How |
|-----------|---------|-----|
| `get_current_user` | `User` ORM object | Validates `Authorization: Bearer <jwt>` |
| `get_redis` | `Redis` client | Singleton connection pool |
| `get_user_settings` | `dict` | Merges `user.settings` JSON with defaults (`llm_provider`, `embedding_provider`, `ollama_embedding_model`, etc.) |
| `get_user_llm_model` | `str` | Extracts validated model from user settings (accepts dynamic Ollama model IDs when `llm_provider=ollama`) |

### Services

#### `llm.py` — LLM Abstraction Layer

Single entry point for all LLM calls:

```python
async def generate_response(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 1024,
    temperature: float = 0.7,
    user_id: str | None = None,
    operation: str = "chat",
    model: str | None = None,           # defaults to settings.anthropic_model
    user_settings: dict | None = None   # per-user API keys / model override
) -> str
```

- Routes to Anthropic / OpenAI / Ollama via provider resolver:
  - static model catalog for cloud models
  - `user_settings["llm_provider"] == "ollama"` for dynamic local IDs
  - prefix fallback (`claude*`, `gpt*`, else assume Ollama)
- Records every call to `ApiUsage` table via `cost_tracker.record_usage()`
- Raises `AIDisabledError` if `user_settings["ai_enabled"]` is `False`

**Prompt templates** (all defined in `llm.py`):

| Template | Used For |
|---------|---------|
| `GHOSTWRITE_SYSTEM/USER` | Reply generation (RAG ghostwriting) |
| `QUERY_SYSTEM/USER` | Chat history / knowledge base Q&A |
| `STYLE_ANALYSIS_PROMPT` | Per-contact style profile generation |
| `SUMMARIZE_SYSTEM/USER` | Contact conversation summary |

#### `response_generator.py` — RAG Pipeline

**`generate_reply(db, user_id, contact_id, user_name, user_instruction, model, user_settings)`**

1. Fetches last 20 messages with the contact from DB
2. Builds a composite retrieval query:
   - Pending thread (last few unread messages)
   - Open questions detected in messages (action signals)
   - User instruction (if provided)
3. Calls `retrieval.retrieve_chunks()` → semantic search
4. Recency-reranks conversation chunks (boost recent by 0.15)
5. Estimates target reply length from conversation patterns
6. Builds GHOSTWRITE prompts including style profile
7. Calls `llm.generate_response()` → Anthropic / OpenAI / Ollama
   - Ghostwrite path caps generation budget at `max_tokens=512` to reduce local timeout risk
8. Stores result as `ResponseSuggestion` with status `pending`
9. Returns suggestion object

**`query_chat_history(db, user_id, question, scope_type, contact_ids, model, user_settings)`**

1. Calls `retrieval.retrieve_chunks()` with scope filter
2. Builds QUERY prompts
3. Calls LLM → returns `{answer: str, sources: list[SourceCitation]}`

#### `retrieval.py` — pgvector Similarity Search

```python
async def retrieve_chunks(
    db: AsyncSession,
    user_id: UUID,
    query: str,
    scope_type: str,           # "all" | "dms" | "groups" | "custom"
    contact_ids: list[UUID],   # used when scope_type = "custom"
    limit: int = 10,
    include_documents: bool = True
) -> list[RetrievedChunk]
```

- Embeds `query` using `embedding.embed_query()`
- Runs raw SQL against `conversation_chunks` using `<=>` cosine distance
- Runs raw SQL against `document_chunks` (general scope + contact-specific if applicable)
- Returns combined results sorted by distance

#### `embedding.py` — Embedding Service

- Provider routing based on `user_settings["embedding_provider"]`:
  - `openai` (primary cloud)
  - `voyageai` (cloud fallback)
  - `ollama` (local embeddings)
- Ollama embeddings are normalized for pgvector compatibility:
  - truncate/pad vectors to 512 dimensions
  - L2-normalize after truncation (Matryoshka-friendly path)
- Ollama embedding batch size: 64 texts
- Cloud embedding batches: 128 texts per API call
- Exponential backoff retry: 5s → 10s → 20s → 40s → 60s on 429/5xx
- All calls recorded to `ApiUsage`

#### `ingestion.py` — 5-Step Pipeline

Runs as `asyncio.create_task()` in the background after upload. Steps:

| Step | Description |
|------|-------------|
| 1. Parse | `telegram_export.py` converts JSON → `ParsedChat`/`ParsedMessage` dataclasses |
| 2. Import | Upsert contacts + bulk-insert messages (dedup by `telegram_msg_id`). Flush every 10 chats |
| 3. Chunk | Session-based chunking: 4-hour gap = new session, ~800 token max per chunk, 3-line overlap |
| 4. Embed | Batch 16 chunks at a time through `embedding.embed_texts()` |
| 5. Style Analyze | Claude analyzes up to 50 of user's messages per DM contact |

Progress is published to Redis → WebSocket → frontend in real-time.

Pause/cancel is checked at each step via:
- `user:paused:{user_id}` key in Redis (global pause)
- `ingest:cancel_job:{user_id}` key in Redis (per-job stop)

Job state is persisted in `IngestionJob` DB table for reconnect recovery.

#### `message_consumer.py` — Real-Time Message Pipeline

Background asyncio task started at app startup. Pattern-subscribes to `telegram:new_messages:*`.

For each incoming message:
1. Resolve `user_id` (UUID or "default" fallback via `telegram_user_id` DB lookup)
2. Upsert contact (get-or-create by `telegram_id`)
3. Deduplicate message by `(contact_id, telegram_msg_id)` unique constraint
4. Save `Message` to DB, update contact stats:
   - `total_messages` incremented
   - `last_message_at` updated **only if message is newer** (monotonic — prevents out-of-order sync messages from resetting recency)
   - `unresponded_count` incremented for incoming, cleared for outgoing **only if newest**
5. If paused: skip steps 6–10, save message only
6. If rechunk threshold met (5 new messages OR 60-second timer): `_rechunk_and_embed_contact()`
7. If incoming DM + `auto_generate` pref enabled: `_auto_generate_suggestion()` using user-selected `llm_model`/`llm_provider`
8. If `auto_draft` enabled: publish `telegram:send_commands:{user_id}` → Monitor saves draft
9. Publish `suggestion_ready` event → `user:{user_id}:events` → WebSocket → frontend

Also listens on:
- `telegram:update_user_name:{user_id}` → updates `user.name` in DB
- `telegram:update_folders:{user_id}` → updates `user.settings["telegram_folders"]`

#### `style_analyzer.py`

Fetches up to 50 of the user's own outgoing messages to a contact, sends to Claude with `STYLE_ANALYSIS_PROMPT`, returns a prose style description stored in `contact.style_profile`. Skips if fewer than 3 messages exist.

#### `cost_tracker.py`

Pricing per 1M tokens (as of Feb 2026):

| Model | Input | Output |
|-------|-------|--------|
| Claude 3.5 Haiku | $0.80 | $4.00 |
| Claude Sonnet 4 | $3.00 | $15.00 |
| Claude Opus 4 | $15.00 | $75.00 |
| GPT-4.1 mini | $0.40 | $1.60 |
| GPT-4.1 | $2.00 | $8.00 |
| Ollama (local, any model) | $0.00 | $0.00 |
| OpenAI text-embedding-3-small | $0.02/1M tokens | — |
| Voyage voyage-4-lite | $0.02/1M tokens | — |

Every call records an `ApiUsage` row with its own DB session (independent of request session).

#### `document_parser.py`

| Format | Parser |
|--------|--------|
| PDF | PyPDF2 (⚠ deprecated, planned → pypdf) |
| DOCX | python-docx |
| TXT / MD | Raw decode |
| URL | trafilatura → BeautifulSoup fallback |

Word-based chunking: 500-word chunks, 50-word overlap.

### Auth Flow (`utils/auth.py`)

- Passwords: bcrypt with `passlib`
- JWTs: `python-jose` HS256, 7-day expiry
- Password reset tokens: embed first 16 chars of password hash → self-invalidate on password change
- **⚠ Known vulnerability**: `python-jose` has CVE-2024-33663 and CVE-2024-33664. Planned replacement: `PyJWT`

---

## 7. Monitor Service Deep-Dive

### Entry Point (`main.py`)

**Startup behavior:**
1. If `TELEGRAM_SESSION_STRING` env var exists → start single-user mode immediately
2. Otherwise: scan Redis for `telegram:session:*` keys (written by backend after OTP verification) → start one asyncio task per user
3. Poll Redis every 10 seconds for new session keys (supports dynamic user onboarding without restart)
4. Reset stale `telegram:connected:*` flags on startup

**Per-user `start_monitor()` function:**
1. Create `TelegramClient` with `StringSession`
2. Set `telegram:connected:{user_id}` in Redis
3. Publish display name → `telegram:update_user_name:{user_id}`
4. Fetch and publish Telegram folder definitions → `telegram:update_folders:{user_id}` (30s timeout, non-blocking — extracts peer IDs directly without slow entity resolution)
5. Register Telethon event handlers (`handlers.py`)
6. Run `initial_sync()` (`sync.py`) — fetches top 200 dialogs, 30 messages each
7. Subscribe to `telegram:send_commands:{user_id}` for outbound commands
8. Send draft commands → `client(SaveDraftRequest(...))`, send message commands → `client.send_message()`
9. Periodic folder re-sync every 5 minutes

### Event Handlers (`handlers.py`)

| Handler | Trigger | Action |
|---------|---------|--------|
| `on_incoming_message` | New message to user | Skip media-only, check pause flag, publish to Redis |
| `on_outgoing_message` | User sends a message | Publish to Redis (resets unresponded count in consumer) |

### Initial Sync (`sync.py`)

- Fetches top 200 dialogs, 30 most recent messages each
- Entity classification:
  - `personal_chat` → DM
  - `group` / `supergroup` → group
  - Broadcast channels → **skipped**
  - Bots → **skipped**
- Uses `publish_sync_message()` (no WebSocket event flooding) with `is_sync=True` flag
- Respects global pause flag, waits up to 5 minutes before aborting sync

### Redis Relay (`relay.py`)

```python
class RedisRelay:
    async def publish_new_message(user_id, message_data)
        # → telegram:new_messages:{user_id}  (consumed by backend)
        # → user:{user_id}:events            (consumed by WebSocket → frontend)

    async def publish_sync_message(user_id, message_data)
        # → telegram:new_messages:{user_id}  only (no WS event during bulk sync)

    async def set_connected(user_id, value)
        # → telegram:connected:{user_id} in Redis

    async def get_session_data(user_id) -> dict
    async def subscribe_send_commands(user_id) -> PubSub
    async def is_user_paused(user_id) -> bool
```

---

## 8. Frontend Deep-Dive

### Auth Flow

- JWT stored in `localStorage` as `"token"`
- `AuthContext` (`hooks/use-auth.ts`) exposes `user`, `login()`, `register()`, `logout()`
- Dashboard layout (`(dashboard)/layout.tsx`) checks `user` on mount → redirects to `/login` if null
- All API calls inject `Authorization: Bearer <token>` via `lib/api.ts`

### API Client (`lib/api.ts`)

Single `request<T>(path, options)` function:
- Reads token from `localStorage`
- Sets `Authorization` header
- Does **not** set `Content-Type` for `FormData` (lets browser set multipart boundary)
- Throws on non-2xx with parsed error message

Namespaced API object:
```typescript
api.auth.login(creds)
api.auth.register(creds)
api.dashboard.getOverview()
api.contacts.list(params)
api.contacts.getMessages(contactId, params)
api.suggestions.generate(contactId, instruction)
api.suggestions.approve(id)
api.ingest.uploadTelegram(file)
api.chat.query(params)
api.settings.requestTelegramCode(phone)
api.settings.verifyTelegramCode(phone, code, password)
api.settings.ollamaStatus()
api.settings.availableEmbeddings()
api.settings.reembed()
// ... etc
```

### WebSocket (`hooks/use-websocket.ts`)

```typescript
useWebSocket({ onEvent: (event) => void })
```

- Opens `wss://<WS_URL>/ws`
- **First message sent** must be `{ "type": "auth", "token": "<jwt>" }` — backend validates and associates the socket with a user
- Reconnects every 3 seconds on close
- **⚠ Known issue**: Each component that mounts this hook opens its own connection — currently 2–3 concurrent WebSocket connections exist simultaneously. Planned fix: move to a singleton context provider.

### Real-Time Event Types

Events received via WebSocket from `user:{user_id}:events`:

| Event type | Payload | Triggered by |
|-----------|---------|-------------|
| `new_message` | message data | Monitor relay |
| `suggestion_ready` | suggestion data | Message consumer |
| `ingestion_progress` | step, progress, total, message | Ingestion pipeline |
| `ingestion_complete` | result | Ingestion pipeline |
| `ingestion_error` | error message | Ingestion pipeline |
| `ingestion_paused` | — | Ingestion pipeline |

### Pages

#### Overview (`/`)
- Stats bento grid (unresponded count, today's messages, active contacts, cost today)
- **Critical Actions**: contacts needing reply, sorted by urgency score (critical/high/medium). Urgency computed from: last message age + unresponded count + message content signals
- **Activity Briefing**: Claude-generated markdown summary of recent activity (cached 5 min in Redis by scope+since key)
- Inline suggestion approval/draft/send/edit modals
- **Scope selector**: all chats / DMs only / groups only / specific contacts / Telegram folder groups

#### Inbox (`/inbox`)
- Contact list with search + sort (urgency, name, last message time)
- Pulsing urgency indicator dots (red = critical)
- "Respond to All" button → generates suggestions for all unresponded contacts

#### Conversation (`/inbox/[contactId]`)
- Full message thread display
- AI-generated summary panel
- Suggestion cards with tone presets (default / formal / casual / brief)
- Composer bar: optional instruction text input, press Enter to generate
- Per-contact auto-reply toggle and auto-draft toggle
- **Query Panel** (`components/inbox/query-panel.tsx`): collapsible AI assistant side panel, supports scope selection including Telegram folder shortcuts, multi-contact chip selection, personalized query suggestions from backend

#### Ingest (`/ingest`)
- Telegram JSON upload (single chat or full export)
- Document upload (PDF, DOCX, TXT, MD)
- URL ingestion
- Real-time progress via WebSocket: step name, progress bar, message
- Pause/resume/stop controls
- Ingestion history table (past jobs with status + timestamps)

#### Settings (`/settings`)
- Telegram OTP flow: enter phone → receive code → verify (optionally with 2FA password)
- Local AI card: Ollama connectivity + model counts + install/pull hints
- Local LLM model picker inside Local AI card
- AI model selector grouped by provider (Local Ollama / Anthropic / OpenAI), only showing available providers
- Embedding provider selector (OpenAI / Voyage / Ollama local) with availability gating
- Re-embed confirmation flow when switching embedding provider
- API key fields: Anthropic, OpenAI, Voyage AI
- Validate-key button (calls `/api/settings/validate-api-key`)
- Dashboard scope preference
- Feature toggles: `auto_generate`, `auto_draft`, `show_urgency`
- Danger zone: "Delete all data" (wipes all user data from DB + Redis)

#### Costs (`/costs`)
- 30-day daily cost area chart
- Cost by service (Anthropic, OpenAI, Voyage)
- Cost by operation (ghostwrite, query, embedding, style_analysis)
- Total token counts

---

## 9. Database Schema

All tables use UUID primary keys. All timestamps are `datetime` (UTC naive — ⚠ `datetime.utcnow()` is deprecated in Python 3.12, 12 occurrences to fix).

### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `email` | String UNIQUE | |
| `name` | String | |
| `hashed_password` | String | bcrypt |
| `telegram_user_id` | BigInteger | Telegram numeric user ID |
| `telegram_session` | Text | Telethon StringSession |
| `telegram_api_id` | String | User's own API credentials |
| `telegram_api_hash` | String | |
| `settings` | JSON | Model prefs, API keys, feature flags, telegram_folders |
| `is_active` | Boolean | |
| `created_at` | DateTime | |
| `last_visited_at` | DateTime | Used for activity briefing |

### `contacts`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | Ownership |
| `telegram_id` | String | Telegram entity ID (unique per user) |
| `display_name` | String | |
| `username` | String | @handle |
| `chat_type` | String | `personal_chat` / `group` / `supergroup` |
| `style_profile` | Text | Claude-generated prose style description |
| `auto_respond` | Boolean | Per-contact auto-respond toggle |
| `unresponded_count` | Integer | |
| `total_messages` | Integer | |

### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `contact_id` | UUID FK → contacts | |
| `telegram_msg_id` | BigInteger | |
| `sender_type` | String | `self` / `other` |
| `sender_name` | String | |
| `content` | Text | |
| `sent_at` | DateTime | |
| `is_read` | Boolean | |
| `is_responded` | Boolean | |

Unique constraint: `(contact_id, telegram_msg_id)`

### `conversation_chunks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `contact_id` | UUID FK → contacts | |
| `chunk_text` | Text | |
| `embedding` | Vector(512) | pgvector, cosine index |
| `session_start` | DateTime | |
| `session_end` | DateTime | |
| `message_count` | Integer | |

### `document_chunks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `document_id` | UUID FK → documents | |
| `chunk_text` | Text | |
| `embedding` | Vector(512) | pgvector, cosine index |
| `chunk_index` | Integer | |

### `response_suggestions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `contact_id` | UUID FK → contacts | |
| `suggested_response` | Text | |
| `context_used` | Text | Source chunks used |
| `status` | String | `pending` / `approved` / `rejected` / `sent` / `drafted` |
| `sent_at` | DateTime | |

### `documents`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `contact_id` | UUID FK → contacts | Nullable; non-null = contact-scoped |
| `filename` | String | |
| `doc_type` | String | `pdf` / `docx` / `txt` / `md` / `url` |
| `source_url` | String | For URL-ingested docs |
| `scope` | String | `general` / `contact` |
| `content_preview` | Text | |
| `chunk_count` | Integer | |

### `ingestion_jobs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | |
| `status` | String | `processing` / `paused` / `complete` / `failed` / `reset` |
| `step` | String | Current step name |
| `progress` / `total` | Integer | For progress bar |
| `message` | String | Human-readable status message |
| `result` | JSON | Final summary stats |
| `filename` | String | |
| `file_hash` | String | SHA256 of uploaded file |
| `chat_date_start` / `chat_date_end` | DateTime | Date range of ingested chats |
| `total_messages_in_file` | Integer | |
| `messages_skipped` | Integer | Deduped on import |

### `api_usage`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | Indexed |
| `service` | String | `anthropic` / `openai` / `voyageai` |
| `model` | String | |
| `operation` | String | `ghostwrite` / `query` / `embedding` / `style_analysis` / etc. |
| `input_tokens` | Integer | |
| `output_tokens` | Integer | |
| `cost_usd` | Numeric | |
| `created_at` | DateTime | Indexed (user_id + created_at) |

### Alembic Migration Files

| File | Description |
|------|-------------|
| `001_initial_schema.py` | Core tables: users, contacts, messages, chunks, suggestions, documents |
| `002_ingestion_jobs.py` | IngestionJob table |
| `003_api_usage.py` | ApiUsage table |
| `003_ingestion_history.py` | Ingestion history fields |
| `004_telegram_credentials.py` | Per-user Telegram credentials |
| `005_user_isolation.py` | `user_id` FK added to messages/chunks, unique constraint on messages |

---

## 10. Redis Channel Map

| Key / Pattern | Type | Publisher | Subscriber | Purpose |
|--------------|------|-----------|------------|---------|
| `telegram:new_messages:{user_id}` | Pub/Sub | Monitor relay | Backend consumer | Live messages arriving |
| `telegram:send_commands:{user_id}` | Pub/Sub | Backend suggestions API | Monitor main | Send / save draft |
| `telegram:session_updated` | Pub/Sub | Backend settings + startup | Monitor main | New session available |
| `telegram:session:{user_id}` | Key (JSON) | Backend settings API | Monitor main (key scan) | Session credentials storage |
| `telegram:connected:{user_id}` | Key (string) | Monitor relay | Backend dashboard | Connection status display |
| `telegram:update_user_name:{user_id}` | Pub/Sub | Monitor main | Backend consumer | TG display name sync |
| `telegram:update_folders:{user_id}` | Pub/Sub | Monitor main | Backend consumer | TG folder definitions |
| `user:{user_id}:events` | Pub/Sub | Monitor relay + backend services | Backend WS endpoint | Frontend real-time events |
| `user:paused:{user_id}` | Key (string) | Backend ingest API | Monitor handlers, consumer, sync | Global pause flag |
| `ingest:cancel_job:{user_id}` | Key (string) | Backend `/api/ingest/stop` | Ingestion pipeline | Stop current job |
| `ingest:cancel_analysis:{user_id}` | Key (string) | Backend `/api/ingest/stop-analysis` | Ingestion pipeline | Stop style analysis only |
| `dashboard:briefing:{user_id}:{scope}:{since}` | Key (JSON, 5-min TTL) | Backend dashboard | — | Activity summary cache |

---

## 11. Data Flow Diagrams

### A. Telegram Ingestion (File Upload)

```
User uploads JSON file
  → POST /api/ingest/telegram (multipart form)
  → Save IngestionJob (status=processing)
  → asyncio.create_task(ingest_telegram_export)
  → Return job_id immediately to frontend

Background task:
  Step 1: Parse JSON → ParsedChat[] / ParsedMessage[]
  Step 2: Upsert contacts + bulk insert messages (dedup by telegram_msg_id)
  Step 3: Session-based chunking (4h gap = new session, ~800 tokens/chunk)
  Step 4: embed_texts() → OpenAI/Voyage → store in conversation_chunks
  Step 5: analyze_contact_style() → Claude → store in contact.style_profile
  → Mark IngestionJob complete
  → Publish ingestion_complete → user:{user_id}:events → WebSocket → Frontend
```

### B. Live Message → Auto-Suggestion

```
New Telegram message arrives
  → Telethon on_incoming_message handler
  → Check pause flag (user:paused:{user_id})
  → RedisRelay.publish_new_message()
      → telegram:new_messages:{user_id}    ← consumed by backend
      → user:{user_id}:events              ← consumed by WebSocket → frontend

Backend message_consumer._process_message():
  → Resolve user_id (UUID or telegram_user_id lookup)
  → Upsert contact (get-or-create by telegram_id)
  → Deduplicate by (contact_id, telegram_msg_id) constraint
  → Save Message to DB
  → If paused: stop here
  → If rechunk threshold met (5 msgs OR 60s):
      → _rechunk_and_embed_contact() in background
  → If DM + auto_generate enabled:
      → _auto_generate_suggestion()
          → response_generator.generate_reply()
              → fetch last 20 messages
              → build composite retrieval query
              → retrieval.retrieve_chunks() → pgvector <=> search
              → build GHOSTWRITE prompts with style_profile
              → llm.generate_response() → Claude/GPT
              → store ResponseSuggestion (status=pending)
          → If auto_draft:
              → Publish to telegram:send_commands:{user_id}
              → Monitor: client(SaveDraftRequest(...))
          → Publish suggestion_ready → user:{user_id}:events → WebSocket → Frontend
```

### C. Manual Reply Generation

```
User clicks "Generate Reply" in UI
  → POST /api/suggestions/generate { contact_id, instruction? }
  → response_generator.generate_reply()
      → [same RAG pipeline as above]
  → Return ResponseSuggestion

User clicks "Approve"
  → POST /api/suggestions/{id}/approve
  → Update status = "approved"
  → [User sends manually via Telegram app, or auto-send if configured]
```

### D. AI Chat Query

```
User submits query in Query Panel
  → POST /api/chat/query { question, scope_type, contact_ids? }
  → embedding.embed_query(question) → 512-dim vector
  → retrieval.retrieve_chunks()
      → SQL: SELECT ... FROM conversation_chunks
             WHERE user_id = ? [AND contact_id IN ?]
             ORDER BY embedding <=> ? LIMIT 10
      → SQL: SELECT ... FROM document_chunks
             WHERE user_id = ? [AND scope filters]
             ORDER BY embedding <=> ? LIMIT 5
  → Build QUERY_SYSTEM + QUERY_USER prompts with retrieved context
  → llm.generate_response() → Claude/GPT
  → Return { answer: str, sources: SourceCitation[] }
```

### E. Telegram OTP Onboarding

```
User submits phone in Settings
  → POST /api/settings/telegram/request-code { phone }
  → Backend calls Telethon.send_code_request()
  → Store phone_code_hash in Redis (_pending_auth dict)
  → Return 200 OK

User submits verification code
  → POST /api/settings/telegram/verify-code { phone, code, password? }
  → Backend calls Telethon.sign_in()
  → Generate StringSession
  → Save to user.telegram_session + user.telegram_user_id in DB
  → Write telegram:session:{user_id} to Redis
  → Publish telegram:session_updated
  → Monitor picks up new session → starts new userbot task
```

---

## 12. API Reference

Base URL: `http://localhost:8000` (local) or `https://api.your-app.railway.app`

All protected endpoints require: `Authorization: Bearer <jwt>`

### Auth (`/api/auth`)

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| POST | `/register` | No | `{email, password, name}` | `{token, user}` |
| POST | `/login` | No | `{email, password}` | `{token, user}` |
| POST | `/forgot-password` | No | `{email}` | `{message}` |
| POST | `/reset-password` | No | `{token, new_password}` | `{message}` |
| GET | `/me` | Yes | — | `User` |

### Chat (`/api/chat`)

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/query` | `{question, scope_type, contact_ids?, model?}` | `{answer, sources[]}` |
| GET | `/suggestions` | query: `contact_id` | `string[]` |
| GET | `/folders` | — | `TelegramFolder[]` |

### Contacts (`/api/contacts`)

| Method | Path | Query Params | Response |
|--------|------|-------------|----------|
| GET | `/` | `search?, sort_by?, limit?, offset?` | `Contact[]` |
| GET | `/{id}` | — | `Contact` |
| GET | `/{id}/messages` | `limit?, offset?, before?` | `Message[]` |
| GET | `/{id}/summary` | — | `{summary: str}` |
| PATCH | `/{id}/settings` | — | `Contact` |

### Dashboard (`/api/dashboard`)

| Method | Path | Response |
|--------|------|----------|
| GET | `/overview` | Stats object |
| GET | `/unresponded` | `Contact[]` with urgency scores |
| GET | `/critical-actions` | `CriticalAction[]` |
| GET | `/activity-summary` | `{summary: str}` (cached) |
| GET | `/scope-options` | Available scope options including TG folders |
| GET | `/costs` | Cost summary |
| PUT | `/scope` | Update dashboard scope preference |
| POST | `/mark-visited` | Update `last_visited_at` |

### Suggestions (`/api/suggestions`)

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/` | query: `contact_id?, status?` | `ResponseSuggestion[]` |
| POST | `/generate` | `{contact_id, instruction?}` | `ResponseSuggestion` |
| POST | `/generate-all` | `{contact_ids[]}` | `ResponseSuggestion[]` |
| POST | `/{id}/approve` | — | `ResponseSuggestion` |
| POST | `/{id}/edit` | `{new_text}` | `ResponseSuggestion` |
| DELETE | `/{id}` | — | `{message}` |

### Ingest (`/api/ingest`)

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/telegram` | `multipart: file` | `{job_id, message}` |
| POST | `/document` | `multipart: file, contact_id?` | `{document_id}` |
| POST | `/url` | `{url, contact_id?}` | `{document_id}` |
| GET | `/active` | — | `IngestionJob \| null` |
| GET | `/history` | `limit?` | `IngestionJob[]` |
| POST | `/pause` | — | `{message}` |
| POST | `/resume` | — | `{message}` |
| POST | `/stop` | — | `{message}` |
| POST | `/stop-analysis` | — | `{message}` |
| POST | `/reset` | — | `{message}` |

### Settings (`/api/settings`)

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/telegram/request-code` | `{phone}` | `{message}` |
| POST | `/telegram/verify-code` | `{phone, code, password?}` | `{message}` |
| GET | `/telegram/status` | — | `{connected, user_id, name}` |
| POST | `/validate-api-key` | `{service, api_key}` | `{valid, error?}` |
| GET | `/ollama/status` | — | `{reachable, chat_models[], embedding_models[]}` |
| GET | `/available-models` | — | `{models[], current, default}` filtered by key/local availability |
| GET | `/available-embeddings` | — | `{providers[], current}` |
| GET | `/ai-status` | — | `{ai_enabled, has_*_api_key, has_ollama, embedding_provider, active_llm_provider, ...}` |
| PUT | `/preferences` | `{ai_enabled?, llm_model?, llm_provider?, embedding_provider?, ollama_embedding_model?, auto_generate?, auto_draft?, show_urgency?, scope_type?}` | Updated prefs (+`requires_reembed` when embedding provider changes) |
| POST | `/reembed` | — | `{status, message, total?}` |
| DELETE | `/delete-all-data` | — | `{message}` |

### Documents (`/api/documents`)

| Method | Path | Response |
|--------|------|----------|
| GET | `/` | `Document[]` |
| DELETE | `/{id}` | `{message}` |

### WebSocket (`/ws`)

Connect to `ws://host:8000/ws`. On connect, immediately send:
```json
{ "type": "auth", "token": "<jwt>" }
```

Server subscribes to `user:{user_id}:events` and forwards all Redis messages as JSON.

### Health Check

`GET /health` → `{"status": "ok", "app": "James Bot"}` (no auth required)

---

## 13. Authentication & Multi-Tenancy

### User Authentication

- Registration: hash password with bcrypt, issue JWT on success
- Login: verify bcrypt hash, issue JWT
- JWT contains: `sub` (user_id UUID), `exp` (7 days)
- Every protected route calls `get_current_user()` which decodes JWT → fetches `User` from DB
- All DB queries include `WHERE user_id = ?` — no cross-user data leakage

### Multi-Tenancy Model

The system is **fully isolated per user**:

| Resource | Isolation |
|---------|-----------|
| Database rows | All tables have `user_id` FK; queries always filter by it |
| pgvector embeddings | `conversation_chunks` and `document_chunks` have `user_id` FK |
| Redis channels | All channels namespaced with `:{user_id}` |
| Telegram sessions | Per-user `StringSession` stored in `user.telegram_session` |
| Monitor userbot tasks | One asyncio task per user, no shared state |
| API keys | Stored in `user.settings` JSON per user |

### "Default User" Fallback (Monitor)

When the Monitor publishes a message and no explicit `user_id` mapping exists (single-user mode), the consumer looks up the user by `telegram_user_id`. If multiple users have the same Telegram user ID (shouldn't happen), the consumer **refuses** to process rather than ambiguously assign.

---

## 14. Deployment (Railway)

### Services Configuration

| Service | Source Dir | Build | Health Check |
|---------|-----------|-------|-------------|
| `api` | `backend/` | Dockerfile | `GET /health` 300s timeout |
| `monitor` | `monitor/` | Dockerfile | None |
| `web` | `frontend/` | Dockerfile (multi-stage) | `GET /` |
| `postgres` | Railway plugin | pgvector 16 | Built-in |
| `redis` | Railway plugin | Redis 7 | Built-in |

### Backend Startup (`entrypoint.sh`)

```bash
#!/bin/sh
alembic upgrade head || echo "Migration warning"
exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
```

Alembic runs **synchronously before uvicorn starts**. If migrations fail, the error is logged but the server starts anyway (to avoid blocking deploys on idempotent migration re-runs).

### Railway-Specific Gotchas

1. **PostgreSQL SSL**: `database.py` auto-disables SSL for `*.railway.internal` hostnames. asyncpg hangs on Railway's internal network if SSL negotiation is attempted. Do not remove this check.

2. **CORS auto-allow**: `FlexibleCORSMiddleware` dynamically allows `*.railway.app` origins. This is intentional — Railway assigns different subdomains per deploy.

3. **Frontend env vars are build-time**: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` are baked into the JS bundle at `next build`. Changing them in Railway's environment does **not** take effect without a full redeploy/rebuild.

4. **Monitor session bootstrap**: On redeploy, the Monitor scans Redis for all `telegram:session:*` keys and restarts userbots automatically. Existing sessions survive backend restarts because they are in the DB and restored to Redis in the backend's lifespan startup.

### Environment Variable Checklist for Railway

```
api service:
  DATABASE_URL          (from Railway Postgres plugin)
  REDIS_URL             (from Railway Redis plugin)
  ANTHROPIC_API_KEY
  JWT_SECRET
  CORS_ORIGINS          (= your frontend Railway URL)
  FRONTEND_URL          (= your frontend Railway URL)
  OPENAI_API_KEY        (optional)
  VOYAGEAI_API_KEY      (optional)
  SMTP_*                (optional, for password reset)

monitor service:
  REDIS_URL
  DATABASE_URL          (only needed for single-user TELEGRAM_SESSION_STRING mode)
  TELEGRAM_SESSION_STRING  (optional, single-user mode only)
  TELEGRAM_API_ID          (optional, single-user mode only)
  TELEGRAM_API_HASH        (optional, single-user mode only)

web service (build vars):
  NEXT_PUBLIC_API_URL   (= https://your-api.railway.app)
  NEXT_PUBLIC_WS_URL    (= wss://your-api.railway.app)
```

---

## 15. Local Development

### Prerequisites

- Docker + Docker Compose
- Node.js 20+
- Python 3.12+

### Quick Start

```bash
# 1. Copy env template
cp .env.example .env
# Edit .env with your API keys (or use local Ollama)

# 2. Start all services
docker compose up --build

# Frontend: http://localhost:3000
# Backend API: http://localhost:8000
# API docs: http://localhost:8000/docs
```

### Local AI (Ollama) Options

```bash
# Option A: run Ollama on host machine (recommended for local dev)
brew install ollama
brew services start ollama
ollama pull llama3.2
ollama pull nomic-embed-text

# Option B: run Ollama in compose profile
docker compose --profile local-ai up --build
```

When API runs in Docker and Ollama runs on host, backend uses:
- `OLLAMA_BASE_URL=http://host.docker.internal:11434`

### Running Services Individually

```bash
# Backend only (needs postgres + redis running)
cd backend
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# Monitor only (needs redis running)
cd monitor
pip install -r requirements.txt
python -m app.main

# Frontend only
cd frontend
npm install
npm run dev
```

### Generating a Telegram Session String (First-Time Setup)

```bash
python scripts/generate_session.py
# Follow prompts: enter phone, code, optional 2FA password
# Copy the output StringSession string
```

Set `TELEGRAM_SESSION_STRING`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` in `.env` for single-user mode, or use the Settings UI for multi-user OTP flow.

### Database Migrations

```bash
# Create a new migration
cd backend
alembic revision --autogenerate -m "description"

# Apply migrations
alembic upgrade head

# Rollback one step
alembic downgrade -1
```

### API Documentation

FastAPI auto-generates OpenAPI docs at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

---

## 16. Known Issues & Active Work

See `docs/REFACTORING_PLAN.md` for the full Feb 2026 audit. Summary:

### Security (Fix First)

| Issue | Location | Fix |
|-------|---------|-----|
| `python-jose` CVE-2024-33663/33664 | `utils/auth.py`, `requirements.txt` | Replace with `PyJWT` |
| `PyPDF2` deprecated | `services/document_parser.py` | Replace with `pypdf` |
| No `.dockerignore` | All Dockerfiles | Add `.dockerignore` to prevent `.env` leaking into image layers |
| Containers run as root | All Dockerfiles | Add `USER nonroot` |
| Blocking `subprocess.run` in async lifespan | `app/main.py` | Use `asyncio.create_subprocess_exec` |
| Blocking `smtplib.SMTP` in async | `utils/email.py` | Use `aiosmtplib` |

### Frontend

| Issue | Location | Fix |
|-------|---------|-----|
| Multiple concurrent WebSocket connections | `hooks/use-websocket.ts` + multiple component mounts | Move to singleton `WebSocketContext` provider in root layout |
| No error boundaries | All pages | Add `error.tsx` files to each route segment |
| ~25 API methods return `any` | `lib/api.ts` | Add proper TypeScript return types |

### Backend

| Issue | Location | Fix |
|-------|---------|-----|
| `ingest_telegram_export` is 432-line god function | `services/ingestion.py` | Split into `IngestPipeline` class with step methods |
| `_process_message` is 139 lines | `services/message_consumer.py` | Extract helper methods |
| N+1 query in dashboard | `api/dashboard.py` | Use JOIN or `IN` clause |
| `datetime.utcnow()` deprecated | 12 occurrences across backend | Replace with `datetime.now(UTC)` |
| Duplicated `get_or_create_contact` | `ingestion.py` + `message_consumer.py` | Extract to shared `contact_service.py` |
| Unbounded in-memory caches | `llm.py`, `api/settings.py`, `services/message_consumer.py` | Add max size or TTL |
| Local LLM timeout spikes on cold models | `services/ollama.py`, `api/suggestions.py` | Mitigated with configurable timeout (`ollama_timeout_seconds`), keep-alive (`ollama_keep_alive`), smaller ghostwrite token budget, and 504 error surfacing |

### Completed Work

- ✅ Multi-tenant user isolation (migration `005_user_isolation.py`)
- ✅ Per-user Redis channel namespacing
- ✅ Unique constraint on `(contact_id, telegram_msg_id)`
- ✅ Ownership verification in RAG pipeline
- ✅ "Default user" ambiguity resolution
- ✅ **Inbox sync & ordering fix** (Feb 2026):
  - Monitor: folder extraction no longer blocks startup (removed slow `get_entity()` calls, added timeouts)
  - Backend: `last_message_at` now monotonic (out-of-order sync messages don't reset recency)
  - Backend: contacts sort uses `.nullslast()` + `created_at` tiebreaker for stable ordering
  - Frontend: inbox list polls every 30s as WebSocket backup

### Active Plan Files

| File | Status | Description |
|------|--------|-------------|
| `.cursor/plans/multi-tenant_user_isolation_1e8a4c3e.plan.md` | Completed | Per-user isolation rollout |
| `.cursor/plans/ingestion_ux_overhaul_461ebb94.plan.md` | In progress | Ingestion UI improvements |
| `.cursor/plans/railway-hosting-runbook_4ac46f51.plan.md` | In progress | Railway deployment hardening |

---

## 17. Naming Conventions & Patterns

### Python (Backend / Monitor)

- **Files**: `snake_case.py`
- **Classes**: `PascalCase`
- **Functions/methods**: `async def snake_case()`
- **Constants**: `UPPER_SNAKE_CASE`
- **Pydantic schemas**: `{Domain}Request`, `{Domain}Response` — in `schemas/`
- **SQLAlchemy models**: singular noun, in `models/` — `class User`, `class Contact`
- **Service functions**: action-first — `generate_reply()`, `retrieve_chunks()`, `embed_texts()`
- **API dependencies**: `get_*` prefix — `get_current_user()`, `get_redis()`
- **Redis keys**: `{namespace}:{qualifier}:{user_id}` — e.g., `telegram:session:{user_id}`

### TypeScript (Frontend)

- **Files**: `kebab-case.tsx` / `kebab-case.ts`
- **Components**: `PascalCase` function components
- **Hooks**: `use-kebab-case.ts`, function name `useCamelCase()`
- **API namespaces**: `api.{domain}.{action}()` — e.g., `api.contacts.list()`
- **Types**: in `types/index.ts`, named `{Domain}` or `{Domain}Response`

### Database

- **Table names**: `snake_case` plural — `conversation_chunks`, `api_usage`
- **Column names**: `snake_case`
- **Foreign keys**: `{table_singular}_id` — e.g., `user_id`, `contact_id`
- **Indexes**: `ix_{table}_{column}` (SQLAlchemy default)

### Git

- Branch names: `feature/{description}` or `fix/{description}`
- No enforced commit message format currently

---

*Last updated: February 18, 2026. Generated from codebase inspection.*
