# James Bot — Telegram AI Reply Assistant

AI-powered Telegram assistant that learns your communication style from chat history, suggests ghostwritten responses, monitors live messages, and lets you query your conversation history.

## Architecture

```
Frontend (Next.js)  ←→  API (FastAPI)  ←→  PostgreSQL + pgvector
                                       ←→  Redis (pub/sub + cache)
                                       ←→  Claude API (LLM)
                                       ←→  Voyage AI (embeddings)
                         Monitor (Telethon)  ←→  Telegram
```

## Tech Stack

- **Backend**: Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic
- **Database**: PostgreSQL 16 + pgvector (vector similarity search)
- **Cache/Queue**: Redis 7 (pub/sub, WebSocket relay)
- **LLM**: Anthropic Claude (response generation, style analysis, summarization)
- **Embeddings**: Voyage AI voyage-3-lite (512 dimensions)
- **Frontend**: Next.js 14, TypeScript, Tailwind CSS, shadcn/ui
- **Telegram**: Telethon (userbot API for live monitoring)
- **Deployment**: Railway (Docker)

## Local Setup (Step-by-Step, Detailed)

### 0) Prerequisites

Install these first:

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js `20+`
- Python `3.12+`

Optional but recommended:

- `psql` and `redis-cli` for quick local checks
- Ollama (if you want local LLM/embeddings)

---

### 1) Clone and prepare environment

From repo root:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

- `JWT_SECRET` (random long string)
- `ANTHROPIC_API_KEY` (if using cloud LLM flow)

Optional keys:

- `OPENAI_API_KEY` (GPT models + OpenAI embeddings)
- `VOYAGEAI_API_KEY` (Voyage embeddings fallback)

Do not commit `.env`.

---

### 2) Choose your AI mode (pick one)

#### Mode A: Cloud APIs (fastest to start)

Keep API keys in `.env`:

- `ANTHROPIC_API_KEY` required for Claude
- `OPENAI_API_KEY` and/or `VOYAGEAI_API_KEY` optional but useful

No Ollama setup required.

#### Mode B: Local AI with Ollama

Option 1 (host Ollama, recommended with Dockerized API):

```bash
brew install ollama
brew services start ollama
ollama pull llama3.2
ollama pull nomic-embed-text
```

`docker-compose.yml` already points API to host Ollama by default:

- `OLLAMA_BASE_URL=http://host.docker.internal:11434`

Option 2 (run Ollama in Compose):

```bash
docker compose --profile local-ai up --build
```

---

### 3) Start the full stack with Docker

From repo root:

```bash
docker compose up --build
```

This starts:

- PostgreSQL (`localhost:5432`)
- Redis (`localhost:6379`)
- API (`http://localhost:8000`)
- Monitor worker (Telethon relay)
- Frontend (`http://localhost:3000`)

First boot may take a few minutes due to image build and dependency install.

---

### 4) Verify services are healthy

Check API health:

```bash
curl http://localhost:8000/health
```

Expected:

```json
{"status":"ok","app":"James Bot"}
```

Open:

- Frontend: `http://localhost:3000`
- API docs: `http://localhost:8000/docs`

If frontend loads but API calls fail, confirm:

- `NEXT_PUBLIC_API_URL=http://localhost:8000`
- `NEXT_PUBLIC_WS_URL=ws://localhost:8000/api/ws`

---

### 5) First-time app setup in UI

1. Register/login at `http://localhost:3000`
2. Go to **Settings** and configure AI preferences/model/provider
3. Connect Telegram:
   - use **Settings -> Telegram** OTP flow, or
   - set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING` in `.env` (single-user mode)
4. Go to **Ingest** and upload Telegram JSON export
5. Wait for ingestion + chunking + embedding to complete
6. Go to **Inbox** and test:
   - auto suggestions
   - manual "Generate Reply"
7. Go to dashboard/query panel and run natural-language history questions

---

### 6) Useful local commands

Rebuild and restart everything:

```bash
docker compose down
docker compose up --build
```

Start with local-ai profile:

```bash
docker compose --profile local-ai up --build
```

Reset containers + volumes (destructive):

```bash
docker compose down -v
```

Generate Telegram session string manually:

```bash
python scripts/generate_session.py
```

---

### 7) Run without Docker (manual services)

Use this only if you prefer native process control.

#### 7.1 Start Postgres + Redis yourself

- Ensure DB exists: `james_bot`
- Ensure pgvector extension is available

#### 7.2 Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

#### 7.3 Monitor

In a new terminal:

```bash
cd monitor
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.main
```

#### 7.4 Frontend

In a new terminal:

```bash
cd frontend
npm install
npm run dev
```

---

### 8) Common local issues (quick fixes)

**API container keeps restarting**

- Check `.env` for malformed values
- Ensure `JWT_SECRET` is set
- Inspect logs: `docker compose logs api`

**No suggestions generated**

- Confirm AI is enabled in Settings
- Confirm model/provider is configured
- Check API logs for provider/auth errors

**Telegram connected but no live events**

- Verify monitor service is running
- Check Redis connectivity (`REDIS_URL`)
- Check monitor logs: `docker compose logs monitor`

**Frontend shows stale env values**

- `NEXT_PUBLIC_*` values are baked at build time
- Rebuild web image: `docker compose up --build web`

## Railway Deployment

Full step-by-step guide. The project uses **five Railway services** that communicate over Railway's private network.

### Architecture on Railway

```
┌──────────────────────────────────────────────────────┐
│  Railway Project                                     │
│                                                      │
│  ┌────────────┐  ┌─────────┐                         │
│  │ PostgreSQL │  │  Redis  │  (Railway add-ons)      │
│  │ + pgvector │  │         │                         │
│  └─────┬──────┘  └────┬────┘                         │
│        │  internal     │  internal                   │
│  ┌─────┴───────────────┴────┐                        │
│  │    api  (FastAPI)        │ ← public domain        │
│  │    backend/              │                        │
│  └─────────────────────┬────┘                        │
│                        │ redis pub/sub               │
│  ┌─────────────────────┴────┐                        │
│  │    monitor  (Telethon)   │ ← no public domain     │
│  │    monitor/              │                        │
│  └──────────────────────────┘                        │
│                                                      │
│  ┌──────────────────────────┐                        │
│  │    web  (Next.js)        │ ← public domain        │
│  │    frontend/             │                        │
│  └──────────────────────────┘                        │
└──────────────────────────────────────────────────────┘
```

### 1. Create the project

1. Go to [railway.app](https://railway.app) → **New Project** → **Empty Project**.
2. **Add PostgreSQL**: Click **+ New** → **Database** → **PostgreSQL**.
3. **Add Redis**: Click **+ New** → **Database** → **Redis**.

Both databases expose internal hostnames (e.g. `pgvector.railway.internal`) that other services can reference.

### 2. Deploy the API (`backend/`)

1. **+ New** → **GitHub Repo** → select your repo.
2. Open the service → **Settings**:
   - **Root Directory**: `backend`
   - **Watch Paths**: `backend/**`
   - **Builder**: should auto-detect **Dockerfile** (from `backend/railway.toml`). If not, set to Dockerfile, path `Dockerfile`.
   - **Start Command**: **leave empty** — the Dockerfile's CMD uses `entrypoint.sh`. A startCommand override will bypass the Dockerfile CMD and can cause hangs (see Troubleshooting).
3. **Variables** (use **Add Reference** for database vars):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Reference → PostgreSQL → `DATABASE_URL` |
   | `REDIS_URL` | Reference → Redis → `REDIS_URL` |
   | `JWT_SECRET` | `openssl rand -hex 32` |
   | `ANTHROPIC_API_KEY` | Your key |
   | `OPENAI_API_KEY` | Your key (optional, for GPT models + embeddings) |
   | `VOYAGEAI_API_KEY` | Your key (optional, for Voyage embeddings) |
   | `CORS_ORIGINS` | Your frontend URL (set after step 4) |

4. **Networking** → **Generate Domain** → note the URL (e.g. `https://api-prod.up.railway.app`).
5. Deploy. Logs should show:

   ```
   === James Bot API Starting ===
   Running Alembic migrations...
   INFO: Application startup complete.
   INFO: Uvicorn running on http://0.0.0.0:8080
   ```

   Health check: `GET /health` → `{"status":"ok","app":"James Bot"}`

### 3. Deploy the Monitor (`monitor/`)

1. **+ New** → **GitHub Repo** → same repo.
2. **Settings**:
   - **Root Directory**: `monitor`
   - **Watch Paths**: `monitor/**`
   - **Builder**: Dockerfile
3. **Variables**:

   | Variable | Value |
   |---|---|
   | `REDIS_URL` | Reference → Redis → `REDIS_URL` |

4. No public domain needed — it runs as a background worker.

### 4. Deploy the Frontend (`frontend/`)

Next.js bakes `NEXT_PUBLIC_*` vars at **build time**, so set them before the first deploy.

1. **+ New** → **GitHub Repo** → same repo.
2. **Settings**:
   - **Root Directory**: `frontend`
   - **Watch Paths**: `frontend/**`
   - **Builder**: Dockerfile
3. **Variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api-prod.up.railway.app` (your API domain) |
   | `NEXT_PUBLIC_WS_URL` | `wss://api-prod.up.railway.app/api/ws` |

4. **Networking** → **Generate Domain** → note the URL.
5. Deploy.
6. **After deploy**, go back to the **API** service and set `CORS_ORIGINS` to the frontend URL. Redeploy the API.

### 5. Config files reference

The repo includes Railway-specific config that the deployment relies on:

**`backend/railway.toml`** — tells Railway to use the Dockerfile builder, sets health check:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

**`backend/entrypoint.sh`** — runs migrations then starts uvicorn:

```bash
#!/bin/bash
set -e
python -m alembic upgrade head || echo "Migration warning"
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
```

**`backend/app/database.py`** — automatically disables SSL for Railway internal connections (asyncpg hangs on SSL negotiation against Railway's private network):

```python
if ".railway.internal" in settings.database_url:
    _connect_args["ssl"] = False
```

### 6. Environment variables checklist

**API (backend)**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | From PostgreSQL add-on |
| `REDIS_URL` | Yes | From Redis add-on |
| `JWT_SECRET` | Yes | Random hex string |
| `ANTHROPIC_API_KEY` | Yes | For Claude models |
| `OPENAI_API_KEY` | No | For GPT models + OpenAI embeddings |
| `VOYAGEAI_API_KEY` | No | For Voyage embeddings (fallback) |
| `CORS_ORIGINS` | Yes | Frontend URL, comma-separated for multiple |
| `FRONTEND_URL` | No | For password reset emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` | No | For email features |

**Monitor**

| Variable | Required | Notes |
|---|---|---|
| `REDIS_URL` | Yes | From Redis add-on |

**Frontend (build-time)**

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Yes | API public URL (`https://...`) |
| `NEXT_PUBLIC_WS_URL` | Yes | WebSocket URL (`wss://...`) |

### 7. Troubleshooting

**API container starts but never becomes healthy (stuck after "Context impl PostgresqlImpl")**

This is almost always one of two things:

1. **Start Command override**: Check service Settings → Deploy → Start Command. It **must be empty**. If Railway has a start command set (e.g. `python -m alembic upgrade head && uvicorn ...`), it bypasses the Dockerfile CMD and runs Alembic without the SSL fix from `database.py`. Clear it and redeploy.

2. **SSL negotiation hang**: asyncpg tries SSL by default. Railway's internal Postgres doesn't use SSL, so the connection hangs indefinitely. The fix is already in `database.py` (sets `ssl=False` for `.railway.internal` hosts). If you see this after a manual engine change, ensure `connect_args={"ssl": False}` is passed.

**API 502 / "Service Unavailable"**

- Check that `DATABASE_URL` and `REDIS_URL` use Railway's **internal** hostnames (via reference variables). Public proxy URLs incur latency and may hit connection limits.
- Check logs: `railway logs --service api`.

**Frontend can't reach API (CORS / network errors)**

- `NEXT_PUBLIC_API_URL` must be the API's **public** URL with `https://`.
- `NEXT_PUBLIC_WS_URL` must use `wss://` scheme.
- `CORS_ORIGINS` on the API must include the frontend origin exactly (no trailing slash).
- These are **build-time** vars — changing them requires a frontend **rebuild**, not just restart.

**Build uses old code (cached Docker layers)**

Railway caches Docker layers. If your code changes aren't taking effect:
- Add a comment change to the Dockerfile to bust the cache.
- Or use `railway up ./backend --service api` from the CLI to deploy local code directly.

**Alembic migration errors on first deploy**

The entrypoint runs `alembic upgrade head` with `|| echo "Migration warning"` so it won't crash the container. If migrations fail, the FastAPI lifespan retries them. Check logs for specific SQL errors.

**"Deployment does not have an associated build" (CLI deploys)**

`railway up` CLI uploads sometimes fail silently. Prefer GitHub-triggered deploys. If you must use CLI, ensure you're linked to the correct service: `railway status`.

### 8. Custom domains (optional)

- **API**: Service → Settings → Networking → Custom Domain.
- **Frontend**: Service → Settings → Networking → Custom Domain.

Update `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` to the custom domains and redeploy both services.

## Project Structure

```
├── backend/          # FastAPI application
│   ├── app/
│   │   ├── api/      # Route handlers
│   │   ├── models/   # SQLAlchemy ORM models
│   │   ├── schemas/  # Pydantic request/response schemas
│   │   ├── services/ # Business logic (RAG, LLM, embedding, etc.)
│   │   ├── tasks/    # Background jobs
│   │   └── utils/    # Helpers (auth, TG parser)
│   └── alembic/      # Database migrations
├── monitor/          # Telethon Telegram monitor service
├── frontend/         # Next.js dashboard
│   └── src/
│       ├── app/      # Pages (App Router)
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       └── types/
├── scripts/          # Utility scripts
└── docker-compose.yml
```

## Key Features

- **Chat History Ingestion**: Upload Telegram Desktop JSON export
- **Per-Contact Style Profiles**: AI analyzes your writing style per contact
- **RAG Response Generation**: Ghostwrites messages using your style + context
- **Live Telegram Monitoring**: Real-time new message notifications
- **Natural Language Query**: Ask questions about your chat history
- **Knowledge Base**: Upload documents/URLs for additional context
- **Real-time Dashboard**: WebSocket-powered status updates
- **Auto-respond**: Optional automatic response generation per contact
