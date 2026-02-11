---
name: Ingestion UX Overhaul
overview: Overhaul the ingestion feature with pause/resume controls, live stats replacing the checklist, descriptive progress labels (no numeric counters), and a full re-ingestion reset mechanism with data cleanup.
todos:
  - id: pause-resume-backend
    content: Add _wait_if_paused() helper in ingestion.py + POST /pause and /resume endpoints in ingest.py
    status: completed
  - id: descriptive-labels
    content: Change progress messages from numeric counters to descriptive labels (chat/contact names)
    status: completed
  - id: live-stats-backend
    content: Add cumulative stats dict to every ingestion_progress event in publish_status()
    status: completed
  - id: reset-endpoint
    content: Add POST /api/ingest/reset endpoint to delete all user's ingested data (contacts cascade)
    status: completed
  - id: frontend-api
    content: Add pause(), resume(), reset() methods to frontend api.ingest client
    status: completed
  - id: frontend-ui-overhaul
    content: "Overhaul ingest page: pause/resume buttons, live stats grid replacing checklist, descriptive activity label, reset button with confirmation dialog"
    status: completed
  - id: pause-state-recovery
    content: Handle 'paused' status in on-mount recovery and polling fallback logic
    status: completed
isProject: false
---

# Ingestion Feature Overhaul

## Current Architecture

The ingestion pipeline is a 5-step `asyncio.create_task` background job (`[backend/app/services/ingestion.py](backend/app/services/ingestion.py)`) that publishes progress via Redis pub/sub to a WebSocket. The frontend (`[frontend/src/app/(dashboard)/ingest/page.tsx](frontend/src/app/(dashboard)`/ingest/page.tsx)) renders a progress bar, a numeric counter ("5 / 448"), a static 5-step checklist, and a single "Stop Processing" button. Stop uses a Redis key flag checked at iteration boundaries.

---

## 1. Pause / Resume Mechanism

### Backend (`[backend/app/services/ingestion.py](backend/app/services/ingestion.py)`)

Add a `_wait_if_paused()` helper alongside the existing `_raise_if_cancelled()`. It uses a Redis key `ingest:pause_job:{user_id}` as a flag:

```python
async def _wait_if_paused(step, progress=None, total=None):
    pause_key = f"ingest:pause_job:{user_id_str}"
    if not await redis_client.exists(pause_key):
        return
    # Publish paused status + update job row to "paused"
    await _status(step, "Paused", progress=progress, total=total)
    _update_job_status("paused")
    # Spin-wait with 1s sleep, also checking for cancel
    while await redis_client.exists(pause_key):
        if await redis_client.exists(cancel_job_key):
            await redis_client.delete(pause_key)
            raise IngestionCancelled()
        await asyncio.sleep(1)
    # Resumed
    _update_job_status("processing")
    await _status(step, "Resumed", progress=progress, total=total)
```

Call `_wait_if_paused()` at the same four check-points where `_raise_if_cancelled()` is already called (before each chat import, before each contact chunk, before each embedding batch, before each style analysis).

### Backend API (`[backend/app/api/ingest.py](backend/app/api/ingest.py)`)

- `POST /api/ingest/pause` -- sets Redis key `ingest:pause_job:{user_id}` with 30-min TTL
- `POST /api/ingest/resume` -- deletes the Redis key

### IngestionJob model (`[backend/app/models/job.py](backend/app/models/job.py)`)

- Expand the `status` column comment/docs to include `"paused"` as a valid value (no schema migration needed since it's a `String(20)`)

### Frontend (`[frontend/src/app/(dashboard)/ingest/page.tsx](frontend/src/app/(dashboard)`/ingest/page.tsx))

- Add `"paused"` to the status union type
- Replace the single "Stop Processing" button with:
  - **Processing state**: "Pause" button (outline) + "Stop" button (destructive)
  - **Paused state**: "Resume" button (primary) + "Stop" button (destructive)
- Wire up `api.ingest.pause()` and `api.ingest.resume()` calls

### Frontend API client (`[frontend/src/lib/api.ts](frontend/src/lib/api.ts)`)

- Add `pause()` and `resume()` methods to `api.ingest`

---

## 2. Replace Progress Counter with Descriptive Activity Label

### Backend (`[backend/app/services/ingestion.py](backend/app/services/ingestion.py)`)

Change the `message` field in progress events to be human-readable context, not numeric:

- **Importing**: `"Syncing: {chat.chat_name}"` (drop the `{i+1}/{total}` from the label)
- **Chunking**: `"Chunking: {contact.display_name}"`
- **Embedding**: `"Generating embeddings..."` (generic, since batches don't have a meaningful name)
- **Analyzing**: `"Analyzing: {contact.display_name}"`

The `progress` and `total` integers still get sent (for the progress bar percentage), but the frontend will not render them as "5 / 448" text.

### Frontend

- Remove the `{currentStep.progress} / {currentStep.total}` paragraph (lines 355-358)
- The `currentStep.label` line will now show the descriptive message from the backend (e.g., "Syncing: RedotPay Official") by using `lastEvent.message` instead of the static `STEP_LABELS` map for the primary label

---

## 3. Live Stats Panel (Replace Step Checklist)

### Backend (`[backend/app/services/ingestion.py](backend/app/services/ingestion.py)`)

Add a `stats` dict to every `ingestion_progress` event payload that tracks cumulative counters. Maintain a running `stats` object throughout the pipeline:

```python
stats = {
    "contacts_processed": 0,
    "messages_synced": 0,
    "duplicates_skipped": 0,
    "chunks_created": 0,
    "embeddings_generated": 0,
    "styles_analyzed": 0,
}
```

Update these as each step processes items. Include `stats` in every `publish_status()` call. Modify `publish_status()` to accept and forward an optional `stats` dict.

### Frontend

Replace the 5-step checklist (lines 377-415) with a stats grid. Proposed layout:

```
         ┌────────────┐  ┌────────────┐  ┌────────────┐
         │  Contacts   │  │  Messages   │  │  Duplicates │
         │     34      │  │  12,847     │  │    203      │
         └────────────┘  └────────────┘  └────────────┘
         ┌────────────┐  ┌────────────┐  ┌────────────┐
         │  Chunks     │  │  Embeddings │  │  Styles     │
         │    892      │  │    892      │  │   18/34     │
         └────────────┘  └────────────┘  └────────────┘
```

- Use a 3-column grid of small stat cards with labels + monospace numbers
- Numbers animate/update live as WebSocket events arrive
- "Duplicates skipped" only shows when > 0, in a warning color
- During early steps, counters not yet reached show as `--` (dimmed)

Also update the **completion view** (lines 418-448) to show the same expanded stats instead of just Chats/Messages/Chunks.

---

## 4. Re-Ingestion with Data Cleanup

### Backend API (`[backend/app/api/ingest.py](backend/app/api/ingest.py)`)

Add `POST /api/ingest/reset` endpoint:

```python
@router.post("/reset")
async def reset_ingestion_data(db, user):
    """Delete ALL ingested Telegram data for the user so they can re-ingest."""
    # Delete all contacts (cascade deletes messages, chunks, suggestions)
    await db.execute(delete(Contact).where(Contact.user_id == user.id))
    # Mark all ingestion jobs as "reset"
    await db.execute(
        update(IngestionJob)
        .where(IngestionJob.user_id == user.id)
        .values(status="reset")
    )
    await db.commit()
    return {"status": "ok", "message": "All data cleared. Ready for re-ingestion."}
```

This leverages the existing `cascade="all, delete-orphan"` on `Contact.messages`, `Contact.conversation_chunks`, and `Contact.suggestions` (`[backend/app/models/contact.py](backend/app/models/contact.py)` lines 37-45) -- deleting contacts cascades everything.

### Frontend

- Add a "Reset & Re-ingest" button in the **Ingestion History** card or as a secondary action in the upload card (only visible when history exists)
- Show a confirmation dialog before executing (this is destructive -- deletes all contacts, messages, chunks, embeddings, style profiles)
- On confirm, call `api.ingest.reset()`, show success toast, refresh history, reset to idle state

### Frontend API client

- Add `reset()` method to `api.ingest`

---

## 5. Additional Details

### WebSocket Event Schema Change

The `ingestion_progress` event payload expands from:

```json
{ "type": "ingestion_progress", "data": { "step": "importing", "progress": 5, "total": 448 }, "message": "..." }
```

to:

```json
{
  "type": "ingestion_progress",
  "data": {
    "step": "importing",
    "progress": 5,
    "total": 448,
    "stats": { "contacts_processed": 5, "messages_synced": 1230, "duplicates_skipped": 42, "chunks_created": 0, "embeddings_generated": 0, "styles_analyzed": 0 }
  },
  "message": "Syncing: RedotPay Official"
}
```

### Pause state recovery on page refresh

The `GET /api/ingest/active` endpoint already returns job status. Since we're adding `"paused"` as a valid status, the on-mount recovery logic in the frontend just needs an additional branch:

```typescript
if (job.status === "paused") {
  setStatus("paused");
  // restore currentStep from job data
}
```

### Files to modify

- `[backend/app/services/ingestion.py](backend/app/services/ingestion.py)` -- pause helper, stats tracking, descriptive messages
- `[backend/app/api/ingest.py](backend/app/api/ingest.py)` -- pause, resume, reset endpoints
- `[backend/app/models/job.py](backend/app/models/job.py)` -- docs update for "paused" status
- `[frontend/src/app/(dashboard)/ingest/page.tsx](frontend/src/app/(dashboard)`/ingest/page.tsx) -- major UI overhaul
- `[frontend/src/lib/api.ts](frontend/src/lib/api.ts)` -- new API methods
- `[backend/app/schemas/ingest.py](backend/app/schemas/ingest.py)` -- update response schemas if needed

