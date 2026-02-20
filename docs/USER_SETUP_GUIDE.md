# James Bot — User Setup Guide

Step-by-step guide to get James Bot running and configured.

---

## Prerequisites

Before starting, you'll need:

- [ ] **Docker Desktop** installed and running ([download](https://docker.com/products/docker-desktop))
- [ ] **Git** installed
- [ ] **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com) → API Keys
- [ ] **OpenAI API key** (recommended) — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- [ ] **Telegram Desktop** with chat history you want to analyze
- [ ] (Optional) **Telegram API credentials** — for live message monitoring

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/TG-reply-bot.git
cd TG-reply-bot
```

---

## Step 2: Configure Environment Variables

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Open `.env` in your editor and fill in your API keys:

```bash
# ─── Required ───
ANTHROPIC_API_KEY=sk-ant-...       # From Anthropic Console
OPENAI_API_KEY=sk-proj-...         # From OpenAI Platform

# ─── Optional (but recommended) ───
VOYAGEAI_API_KEY=pa-...            # Better embeddings (voyage-3-lite)
```

> **Note**: Leave `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` as-is for local development. Docker Compose handles them.

---

## Step 3: Start the Application

```bash
docker compose up --build
```

Wait for all services to start. You'll see:
- PostgreSQL running on port 5432
- Redis running on port 6379
- API running on port 8000
- Frontend running on port 3000

First startup takes 2-5 minutes to build containers.

---

## Step 4: Create Your Account

1. Open [http://localhost:3000](http://localhost:3000)
2. Click **Sign Up**
3. Enter your email and password
4. Click **Create account**
5. You are now logged in

---

## Step 5: Export Your Telegram Chat History

James learns your writing style from your Telegram history.

### From Telegram Desktop:

1. Install/open **Telegram Desktop** (not mobile): [telegram.org/apps](https://telegram.org/apps)
2. Open a chat you want to analyze
3. Click the **⋮** menu (top right) → **Export chat history**
4. Configure export settings:
   - **Format**: JSON
   - Photos/voice/video: optional
   - **Size limit**: None / All time
   - **Path**: choose a folder you can find easily
5. Click **Export**
6. Find the exported `result.json` file

### Multiple chats:
Repeat this for each contact. Each chat gives you a separate `result.json`.

---

## Step 6: Upload Chat History to James

1. Go to **Ingest** in the sidebar
2. Click **Upload Chat Export**
3. Select your `result.json` file(s)
4. Wait for upload + processing to finish

James will:
- Read your messages
- Learn your style per contact
- Save searchable context for better replies

---

## Step 7: Generate AI Responses

1. Go to **Inbox** in the sidebar
2. Select a contact from the list
3. You'll see your conversation history
4. Click **Generate Response**
5. Edit the draft if needed
6. Copy and send it in Telegram

The draft is based on your past style + recent chat context.

---

## Step 8: (Optional) Connect Live Telegram Monitoring

This gives you real-time updates when new Telegram messages arrive.

### Get Telegram API Credentials:

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click **API development tools**
4. Create a new application (any name)
5. Copy your **API ID** and **API Hash**

### Important: Temporarily disable Telegram 2FA first

If Telegram **Two-Step Verification** (password/2FA) is ON, Telethon login can fail.

1. Open Telegram app settings (mobile or desktop)
2. Go to **Privacy and Security** → **Two-Step Verification**
3. Turn it **OFF** for setup
4. Connect James first (steps below)
5. Turn 2FA back **ON** right after connection

Telegram security docs: [telegram.org/faq#q-how-do-i-enable-two-step-verification](https://telegram.org/faq#q-how-do-i-enable-two-step-verification)

### Configure in James:

1. Go to **Settings** in the sidebar
2. Enter your **API ID** and **API Hash**
3. Enter your **phone number** (with country code, e.g., +1234567890)
4. Click **Connect**
5. Enter the **OTP code** sent to your Telegram
6. After successful connection, re-enable Telegram 2FA
7. Live monitoring is now active

New messages will appear in real-time in your Inbox.

---

## Step 9: (Optional) Add Knowledge Documents

Add your own docs for better replies.

1. Go to **Knowledge** in the sidebar
2. Upload PDFs, documents, or paste URLs
3. James indexes them and uses relevant parts in replies

Use cases:
- Work docs for tone and terminology
- Specs and notes for better technical replies
- Personal notes for reference

---

## Common Commands

```bash
# Start the app
docker compose up

# Start in background
docker compose up -d

# Stop the app
docker compose down

# View logs
docker compose logs -f api

# Rebuild after code changes
docker compose up --build

# Reset database (WARNING: deletes all data)
docker compose down -v
docker compose up --build
```

---

## Troubleshooting

### "Cannot connect to API"

- Ensure all containers are running: `docker compose ps`
- Check API logs: `docker compose logs api`
- Verify port 8000 isn't used by another app

### "Embeddings failing"

- Check your `OPENAI_API_KEY` or `VOYAGEAI_API_KEY` in `.env`
- API key must have embedding model access

### "Telegram connection fails"

- Verify API ID/Hash are correct from my.telegram.org
- Ensure phone number includes country code (+1, +44, etc.)
- Check you're using the same phone number as your Telegram account

### "Chat export not processing"

- Ensure you exported as **JSON** (not HTML)
- File should be named `result.json`
- Check the file isn't empty or corrupted

### Slow first startup

Normal — Docker builds all images on first run. Subsequent starts are fast.

---

## Updating

```bash
git pull
docker compose up --build
```

---

## Production Deployment (Railway)

See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md) for hosting on Railway with custom domain.

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Frontend   │────▶│   FastAPI    │────▶│ PostgreSQL+pgvector│
│  (Next.js)  │◀────│   Backend    │────▶│      Redis         │
└─────────────┘     └──────┬───────┘     └────────────────────┘
                           │
                    ┌──────▼───────┐
                    │   Claude AI   │
                    │   Voyage AI   │
                    │   OpenAI      │
                    └──────────────┘
```

- **Frontend**: Dashboard UI for managing contacts, generating responses
- **Backend**: API server, message processing, AI orchestration
- **Monitor**: (Optional) Live Telegram message listener
- **PostgreSQL + pgvector**: Message storage + vector similarity search
- **Redis**: Real-time pub/sub for WebSocket updates
