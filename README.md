# James Bot — Telegram AI Reply Assistant

AI-powered Telegram assistant that learns how you talk, suggests replies in your style, monitors live messages, and lets you search through your chat history using natural language.

## What is this?

James Bot reads your Telegram chat history, learns your writing style, and then helps you reply to messages — in your own voice. It watches your live conversations and suggests responses you can send with one click. You can also ask it questions about past conversations like "What did I talk about with John last week?"

## How it works

```
Your Telegram Chats
        ↓
   Ingest + Embed (Voyage AI)
        ↓
   PostgreSQL + pgvector (vector search)
        ↓
   Claude AI (style analysis + reply generation)
        ↓
   Web Dashboard (Next.js)
   ├── Inbox → live messages + suggested replies
   ├── Query → ask questions about your chat history
   └── Settings → AI model, style preferences
```

## Features

- **Learns your style** — analyzes your past messages to write replies that sound like you
- **Live monitoring** — watches incoming Telegram messages in real-time
- **Ghostwritten replies** — one-click suggested responses for every message
- **Chat history search** — ask natural language questions about old conversations
- **Multiple AI modes** — cloud (Claude, GPT) or local (Ollama)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.12, FastAPI, SQLAlchemy |
| **Database** | PostgreSQL 16 + pgvector |
| **Cache** | Redis 7 (pub/sub, WebSocket relay) |
| **LLM** | Claude (generation + style analysis) |
| **Embeddings** | Voyage AI voyage-3-lite |
| **Frontend** | Next.js 14, TypeScript, Tailwind, shadcn/ui |
| **Telegram** | Telethon (live monitoring) |
| **Deploy** | Docker Compose, Railway |

## Getting Started

```bash
git clone https://github.com/deb-pradhan/James-Bot-Offline.git
cd James-Bot-Offline
cp .env.example .env    # add your API keys
docker compose up --build
```

This starts PostgreSQL, Redis, the API, the Telegram monitor, and the frontend.

- **Frontend**: http://localhost:3000
- **API docs**: http://localhost:8000/docs

### First-time setup

1. Register at http://localhost:3000
2. Connect your Telegram account in Settings
3. Upload a Telegram chat export in the Ingest page
4. Go to Inbox — replies will start appearing automatically

## License

MIT
