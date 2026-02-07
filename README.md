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

## Quick Start (Local Development)

### Prerequisites

- Docker & Docker Compose
- Node.js 20+
- Python 3.12+
- Anthropic API key
- Voyage AI API key

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 2. Start with Docker Compose

```bash
docker compose up --build
```

This starts:
- PostgreSQL (port 5432)
- Redis (port 6379)
- API server (port 8000)
- Telegram monitor
- Frontend (port 3000)

### 3. Open the dashboard

Visit [http://localhost:3000](http://localhost:3000), create an account, and:

1. **Upload chat export**: Go to Ingest → upload your Telegram JSON export
2. **Connect Telegram**: Go to Settings → enter API credentials → verify OTP
3. **Upload documents**: Go to Knowledge → upload PDFs, docs, or URLs
4. **Start chatting**: Go to Inbox → generate responses or query history

## Alternative: Run without Docker

### Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Start PostgreSQL and Redis locally, then:
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

### Monitor

```bash
cd monitor
pip install -r requirements.txt
python -m monitor.app.main
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Railway Deployment

### Services to create:

1. **PostgreSQL** — Add via Railway plugin (enable pgvector)
2. **Redis** — Add via Railway plugin
3. **api** — Deploy from `./backend` directory
4. **monitor** — Deploy from `./monitor` directory
5. **web** — Deploy from `./frontend` directory

### Environment Variables

Set these on each service:

**api service:**
- `DATABASE_URL` → auto-set by Railway PostgreSQL plugin
- `REDIS_URL` → auto-set by Railway Redis plugin
- `ANTHROPIC_API_KEY`
- `VOYAGEAI_API_KEY`
- `JWT_SECRET`
- `CORS_ORIGINS` → your frontend URL

**monitor service:**
- `REDIS_URL` → reference from Redis plugin

**web service (build args):**
- `NEXT_PUBLIC_API_URL` → your API service URL
- `NEXT_PUBLIC_WS_URL` → your API service URL (wss:// scheme)

### Railway pgvector Setup

After deploying, connect to your Railway PostgreSQL and run:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
The API's startup also attempts this automatically.

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
