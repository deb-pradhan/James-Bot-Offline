# Deploy TG-reply-bot to Railway

Step-by-step guide to host the full stack (Postgres, Redis, API, Monitor, Frontend) on Railway.

---

## Prerequisites

- [Railway account](https://railway.app) (GitHub login)
- Repo pushed to GitHub
- All secrets ready (Anthropic, OpenAI, Voyage, JWT, optional Telegram) — **do not commit** `.env`

---

## 1. Create project and add Postgres + Redis

1. Go to [railway.app](https://railway.app) → **New Project**.
2. **Add Postgres**: Click **+ New** → **Database** → **PostgreSQL**. Wait until it’s provisioned.
3. **Add Redis**: Click **+ New** → **Database** → **Redis**. Wait until it’s provisioned.
4. Open the **Postgres** service → **Variables** (or **Connect**). Copy the **`DATABASE_URL`** (Railway sets it automatically).
5. Open the **Redis** service → **Variables**. Copy **`REDIS_URL`** (or note the internal URL Railway shows).

You’ll inject these into the API and Monitor services in a later step.

---

## 2. Deploy the API (backend)

1. In the same project, click **+ New** → **GitHub Repo**.
2. Select your **TG-reply-bot** repo.
3. Railway creates a new service. Open it → **Settings**.
4. Set **Root Directory** to `backend`.
5. Set **Watch Paths** to `backend/**` (so only backend changes trigger deploys).
6. **Build**: Railway should detect the **Dockerfile** in `backend/`. If it doesn’t, set **Builder** to **Dockerfile** and leave **Dockerfile path** as `Dockerfile`.
7. **Deploy**: Leave **Start Command** empty (the Dockerfile uses `./entrypoint.sh`).
8. **Variables**: Click **Variables** and add (use “New Variable” or “Add from reference” for Postgres/Redis):

   - `DATABASE_URL` — from Postgres service (use **Add Reference** → Postgres → `DATABASE_URL`).
   - `REDIS_URL` — from Redis service (Add Reference → Redis → `REDIS_URL` or the variable Railway provides).
   - `JWT_SECRET` — strong random string (e.g. `openssl rand -hex 32`).
   - `ANTHROPIC_API_KEY` — your key.
   - `OPENAI_API_KEY` — your key.
   - `VOYAGEAI_API_KEY` — your key (optional if you only use OpenAI).
   - `CORS_ORIGINS` — set to your frontend URL, e.g. `https://your-app.up.railway.app` (you’ll add the exact URL after deploying the frontend; you can add multiple origins comma-separated).

9. **Networking**: In **Settings** → **Networking** → **Generate Domain**. Note the URL (e.g. `https://your-api.up.railway.app`). This is your **API base URL** and **WS URL** for the frontend.

10. Deploy and wait until the API is healthy (logs show “Application startup complete” or similar).

---

## 3. Deploy the Monitor service

1. In the project, click **+ New** → **GitHub Repo** again and select the **same** repo.
2. Open the new service → **Settings**.
3. **Root Directory**: `monitor`.
4. **Watch Paths**: `monitor/**`.
5. **Builder**: Dockerfile (path `Dockerfile`).
6. **Variables**:
   - `REDIS_URL` — Add Reference → Redis → `REDIS_URL`.
   - Copy any other env vars the monitor needs from your local setup (e.g. if it talks to the API, use the API’s internal hostname or the public URL; check `monitor/app/config.py` or equivalent).
7. No public domain needed unless you want to expose it. The monitor runs in the background.

---

## 4. Deploy the Frontend (Next.js)

Frontend needs **build-time** env vars for the API and WebSocket URLs.

1. In the project, click **+ New** → **GitHub Repo** and select the **same** repo again.
2. Open the new service → **Settings**.
3. **Root Directory**: `frontend`.
4. **Watch Paths**: `frontend/**`.
5. **Builder**: Dockerfile (path `Dockerfile`).
6. **Variables** — add these so they’re available at **build** time (Railway injects them into the Docker build):
   - `NEXT_PUBLIC_API_URL` — your API’s public URL, e.g. `https://your-api.up.railway.app`.
   - `NEXT_PUBLIC_WS_URL` — WebSocket URL, e.g. `wss://your-api.up.railway.app/api/ws` (same host as API, `wss` in production).
7. **Networking**: **Generate Domain** and note the URL (e.g. `https://your-app.up.railway.app`).
8. Deploy.

After the first deploy, go back to the **API** service and set:
- `CORS_ORIGINS` = `https://your-app.up.railway.app` (your frontend domain).

Redeploy the API if you had set a placeholder before.

---

## 5. Run migrations (first time)

Migrations run in the API container via `entrypoint.sh` (`alembic upgrade head`). If the API container starts successfully, migrations have run.

If you need to run them manually (e.g. one-off):

1. Install Railway CLI: `npm i -g @railway/cli` (or see [railway.app/docs/develop/cli](https://docs.railway.app/develop/cli)).
2. Log in: `railway login`.
3. Link project: `railway link` (choose the project).
4. Run in API service context:
   ```bash
   railway run -s <api-service-name> -- python -m alembic upgrade head
   ```
   Or use **Settings** → **Deploy** → one-off run if your plan supports it.

---

## 6. Summary of services

| Service   | Root Dir   | Purpose                          | Public URL |
|----------|------------|-----------------------------------|------------|
| Postgres | —          | Database (Railway add-on)         | Internal   |
| Redis    | —          | Cache/queue (Railway add-on)      | Internal   |
| API      | `backend`  | FastAPI + migrations              | Yes        |
| Monitor  | `monitor`  | Background worker                 | No         |
| Web      | `frontend` | Next.js app                       | Yes        |

---

## 7. Env vars checklist

**API (backend)**  
- `DATABASE_URL` (from Postgres)  
- `REDIS_URL` (from Redis)  
- `JWT_SECRET`  
- `ANTHROPIC_API_KEY`  
- `OPENAI_API_KEY`  
- `VOYAGEAI_API_KEY` (optional)  
- `CORS_ORIGINS` (frontend URL, e.g. `https://your-app.up.railway.app`)  
- Optional: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE`, `TELEGRAM_SESSION_STRING`

**Monitor**  
- `REDIS_URL` (from Redis)  
- Any API URL or config your monitor needs

**Frontend (build-time)**  
- `NEXT_PUBLIC_API_URL` (e.g. `https://your-api.up.railway.app`)  
- `NEXT_PUBLIC_WS_URL` (e.g. `wss://your-api.up.railway.app/api/ws`)

---

## 8. Custom domains (optional)

- **API**: API service → **Settings** → **Networking** → **Custom Domain**.
- **Frontend**: Web service → **Settings** → **Networking** → **Custom Domain**.

Then set `CORS_ORIGINS` and `NEXT_PUBLIC_*` to those domains and redeploy where needed.

---

## 9. Troubleshooting

- **API 502 / not starting**: Check logs for DB/Redis connection errors. Ensure `DATABASE_URL` and `REDIS_URL` use Railway’s internal hostnames (reference vars).
- **Frontend can’t reach API**: Confirm `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` match the API’s public URL and use `https`/`wss`. CORS: `CORS_ORIGINS` must include the frontend origin.
- **Build fails (frontend)**: Ensure **Variables** are set **before** the build; Next.js bakes `NEXT_PUBLIC_*` into the bundle at build time.
- **Migrations**: If the API container fails on first start, check logs for Alembic errors (e.g. DB not reachable). Fix DB URL and redeploy.
