# Chat Intelligence Optimization Plan

## Outcome

Upgrade chat intelligence so the system can:

1. Alert you immediately when your username/name is mentioned or when someone asks you to do something.
2. Extract and track todos from incoming chats (with assignee, deadline, status).
3. Help you maintain relationships with proactive follow-ups, memory summaries, and priority signals.

This plan is designed for the current architecture (`message_consumer` + Redis pub/sub + WebSocket + RAG services) and avoids heavy rewrites.

---

## 0) Current Architecture Fit

Existing pieces we will reuse:

- Ingestion + live message pipeline in `backend/app/services/message_consumer.py`
- Query + RAG flow in `backend/app/api/chat.py` and `backend/app/services/response_generator.py`
- WebSocket event fanout via `user:{user_id}:events`
- Contact/message models and user settings JSON in `users.settings`

Core strategy:

- Add **lightweight deterministic detectors** first (mentions, tasks, dates, question/request patterns).
- Add **LLM assist only where deterministic logic is weak** (task normalization, relationship insights).
- Persist intelligence artifacts in DB tables to keep everything auditable and queryable.

---

## 1) Phase 1 — Mention + Action Alerts (highest ROI)

### 1.1 Detection logic

Add a new service:

- `backend/app/services/alert_detector.py`

Implement:

- `detect_alert_signals(message_text, user_profile, contact_meta) -> list[AlertSignal]`

Signals to detect:

- Direct mention by username/handle:
  - `@{username}` exact match
- Name callouts:
  - case-insensitive word-boundary match on user display name + configured aliases
- Task/request directed at user:
  - imperative/request patterns near mention:
    - `"can you"`, `"please"`, `"need you to"`, `"could you"`, `"when can you"`, `"remind me"`, `"send"`, `"review"`, `"follow up"`

Priority scoring (0-100):

- Mention only: 55
- Mention + request verb: 75
- Mention + request + deadline cue (`today`, `tomorrow`, explicit date/time): 90

### 1.2 Runtime integration

Integrate into `backend/app/services/message_consumer.py` inside `_process_message()` after message save and pause check:

1. Load user identity fields:
   - `user.name`
   - `users.settings["alert_aliases"]` (new optional config)
   - Telegram handle if available
2. Run `detect_alert_signals(...)`
3. Persist alerts (new table below)
4. Publish event:
   - channel: `user:{user_id}:events`
   - type: `mention_alert`

Event payload contract:

```json
{
  "type": "mention_alert",
  "data": {
    "alert_id": "uuid",
    "contact_id": "uuid",
    "contact_name": "string",
    "message_id": "uuid",
    "message_preview": "string",
    "severity": "medium|high|urgent",
    "reason": "mention|mention_and_task|deadline_request"
  },
  "message": "You were mentioned by Alice and asked to send the contract today."
}
```

### 1.3 Data model

Add model:

- `backend/app/models/alert.py`

Table: `chat_alerts`

- `id` UUID PK
- `user_id` UUID FK
- `contact_id` UUID FK
- `message_id` UUID FK
- `alert_type` string (`mention`, `task_request`, `deadline_request`)
- `severity` string (`low`, `medium`, `high`, `urgent`)
- `status` string (`new`, `seen`, `dismissed`, `resolved`)
- `reason` text
- `created_at` datetime
- `resolved_at` datetime nullable

Indexes:

- `(user_id, status, created_at desc)`
- `(user_id, contact_id, created_at desc)`

Migration:

- Add Alembic revision `00x_chat_alerts_and_todos.py`

### 1.4 API + frontend

Backend API:

- New router file: `backend/app/api/alerts.py`
- Endpoints:
  - `GET /api/alerts?status=&severity=&limit=&offset=`
  - `POST /api/alerts/{id}/seen`
  - `POST /api/alerts/{id}/dismiss`
  - `POST /api/alerts/{id}/resolve`

Frontend:

- `frontend/src/lib/api.ts`: add `api.alerts.*`
- `frontend/src/types/index.ts`: add `ChatAlert` types
- `frontend/src/app/(dashboard)/page.tsx`: add "Needs You" widget
- Optional badge in inbox row (`frontend/src/components/inbox/*`) when unresolved high/urgent alert exists.

---

## 2) Phase 2 — Todo Intelligence (extract + track + follow through)

### 2.1 Task extraction pipeline

Add service:

- `backend/app/services/todo_extractor.py`

Functions:

- `extract_candidate_todos(message_text, context) -> list[TodoCandidate]`
- `normalize_todo_with_llm(candidate, thread_context) -> TodoNormalized`

Hybrid strategy:

1. Deterministic first pass:
   - request verbs + commitment phrases (`I will`, `I'll`, `let me`, `can you`, `please`, `by Friday`)
2. LLM normalization second pass (cheap model / local Ollama allowed):
   - turn messy text into structured fields:
     - `title`
     - `owner` (`me`, `them`, `unknown`)
     - `due_at` (ISO if parseable)
     - `confidence`
     - `source_excerpt`

### 2.2 Data model

Add model:

- `backend/app/models/chat_todo.py`

Table: `chat_todos`

- `id` UUID PK
- `user_id` UUID FK
- `contact_id` UUID FK nullable
- `source_message_id` UUID FK nullable
- `title` text
- `description` text nullable
- `owner` string (`me`, `contact`, `shared`)
- `status` string (`open`, `in_progress`, `done`, `dropped`)
- `priority` string (`low`, `medium`, `high`)
- `due_at` datetime nullable
- `confidence` float
- `created_at` datetime
- `updated_at` datetime
- `completed_at` datetime nullable

Indexes:

- `(user_id, status, due_at)`
- `(user_id, owner, status)`

### 2.3 Runtime hooks

In `message_consumer.py`:

- For incoming messages: extract todos where `owner=me` or `shared`.
- For outgoing messages: detect completion phrases and auto-close linked todo candidates (confidence threshold).

Also add dedup logic:

- If same contact + semantically similar title + close timestamp window, update existing todo instead of creating a duplicate.

### 2.4 API + UI

Backend API:

- New `backend/app/api/todos.py`
- Endpoints:
  - `GET /api/todos?status=&owner=&due_before=&contact_id=`
  - `POST /api/todos` (manual create)
  - `PATCH /api/todos/{id}` (status, due date, priority, title)
  - `POST /api/todos/{id}/done`
  - `POST /api/todos/{id}/link-message`

Frontend:

- Add dashboard "My Chat Todos" list with:
  - overdue / today / upcoming segments
  - one-click `done`
  - open conversation shortcut

---

## 3) Phase 3 — Relationship Intelligence (better follow-ups + stronger trust)

### 3.1 Relationship memory model

Add model:

- `backend/app/models/relationship_memory.py`

Table: `relationship_memories`

- `id`, `user_id`, `contact_id`
- `memory_type` (`personal_fact`, `preference`, `important_date`, `open_loop`, `sentiment_trend`)
- `memory_text`
- `source_message_id`
- `confidence`
- `last_confirmed_at`
- `created_at`

### 3.2 Extraction and refresh jobs

Add service:

- `backend/app/services/relationship_intel.py`

Functions:

- `extract_relationship_memories(contact_id, last_n_messages=200)`
- `compute_followup_score(contact_id) -> float`
- `generate_followup_prompt(contact_id) -> str`

Follow-up score features:

- days since last outbound message
- unresolved incoming questions count
- open todo count for this contact
- sentiment decay / tension cues
- relationship tier (manual setting in contact preferences)

### 3.3 Product behaviors

1. Dashboard widget: "People to follow up with"
2. Contact card additions:
   - key facts (short bullets)
   - pending commitments
   - recommended next touch message
3. New chat query intent examples:
   - "Who should I follow up with today?"
   - "What promises did I make to Bob?"
   - "What matters to Alice lately?"

---

## 4) Phase 4 — Smarter Query/Reply Intelligence

### 4.1 Intent routing in chat query

Extend `backend/app/api/chat.py` + `response_generator.query_chat_history` with optional intent hints:

- `intent = alert_lookup | todo_lookup | relationship_lookup | generic_rag`

Add pre-query classifier in new service:

- `backend/app/services/query_intent.py`

Examples:

- If question contains "todo", "task", "due", route to `chat_todos` SQL first, then augment with RAG snippets.
- If contains "follow up", "relationship", "promised", route through relationship memory tables first.

### 4.2 Better answer shape for operations

Extend `QueryResponse` in `backend/app/schemas/chat.py`:

- optional structured blocks:
  - `action_items[]`
  - `alerts[]`
  - `recommended_replies[]`

This preserves backward compatibility by keeping `answer` and `sources`.

### 4.3 Draft quality controls

In `response_generator.generate_reply()`:

- Include unresolved todo + commitment context in `priority_brief`.
- Add "do not hallucinate commitments" guardrails:
  - if uncertain, ask a clarifying question instead of asserting facts.

---

## 5) Settings / Preferences to Add

In `users.settings` and settings API:

- `alert_aliases: string[]` (names/handles to treat as mentions)
- `alert_min_severity: "low|medium|high|urgent"`
- `todo_auto_extract: boolean` (default true)
- `relationship_digest_enabled: boolean` (default true)
- `relationship_digest_hour_local: int` (0-23)

Update:

- `backend/app/api/settings.py`
- `backend/app/schemas/settings.py` (if present)
- frontend settings page in `frontend/src/app/(dashboard)/settings/page.tsx`

---

## 6) Rollout Plan (implementation order)

### Sprint 1 (2-3 days)

- Add `chat_alerts` model + migration + API
- Implement deterministic mention/task detection
- WebSocket alert events + dashboard "Needs You" list

### Sprint 2 (3-4 days)

- Add `chat_todos` model + migration + API
- Implement hybrid todo extractor
- Add todo dashboard + quick actions

### Sprint 3 (4-5 days)

- Add relationship memory model + extraction jobs
- Add follow-up scoring + recommendations
- Integrate relationship-aware query intents

### Sprint 4 (2-3 days)

- Tighten prompts + structured query response
- Add evaluation harness + regression tests

---

## 7) Test Plan (must-have)

### Backend unit tests

- Mention detection:
  - username mention, name mention, false-positive filters
- Task extraction:
  - parse deadline, owner, status transitions
- Relationship scoring:
  - score rises when unanswered and stale

### Integration tests

- `message_consumer` emits `mention_alert` on live message
- Todo auto-extraction creates/updates `chat_todos`
- `/api/chat/query` returns structured action items for todo intent

### Frontend

- Dashboard widgets render and update from WebSocket events
- Marking alert seen/dismissed updates badge counts
- Todo quick actions optimistic update + rollback on failure

---

## 8) Guardrails / Anti-noise Rules

To avoid alert/todo spam:

- Mention debounce: same contact + same reason within 10 min -> merge
- Task confidence threshold:
  - auto-create todo only if confidence >= 0.72
  - otherwise store as suggestion queue for review
- Daily digest cap for relationship nudges (max N recommendations/day)

---

## 9) Metrics to Track

Add metrics events for:

- alert precision proxy: `% alerts marked useful`
- todo completion uplift: `completed_within_7d`
- response speed improvement: `median time to first reply after mention`
- relationship health proxy: `% high-score contacts followed up within 48h`

Store in existing analytics pattern (`api_usage`-like tracking table or new telemetry table).

---

## 10) Concrete File Change Map

### New backend files

- `backend/app/models/alert.py`
- `backend/app/models/chat_todo.py`
- `backend/app/models/relationship_memory.py`
- `backend/app/services/alert_detector.py`
- `backend/app/services/todo_extractor.py`
- `backend/app/services/relationship_intel.py`
- `backend/app/services/query_intent.py`
- `backend/app/api/alerts.py`
- `backend/app/api/todos.py`
- `backend/app/api/relationships.py` (optional if exposing direct endpoints)
- `backend/alembic/versions/00x_chat_alerts_and_todos.py`

### Backend files to modify

- `backend/app/services/message_consumer.py`
- `backend/app/api/chat.py`
- `backend/app/services/response_generator.py`
- `backend/app/schemas/chat.py`
- `backend/app/api/settings.py`
- `backend/app/main.py` (register new routers)

### Frontend files to modify

- `frontend/src/lib/api.ts`
- `frontend/src/types/index.ts`
- `frontend/src/app/(dashboard)/page.tsx`
- `frontend/src/app/(dashboard)/settings/page.tsx`
- `frontend/src/components/inbox/query-panel.tsx` (intent-aware quick prompts)
- `frontend/src/components/inbox/*` (alert badges + todo affordances)

---

## 11) Optional contrarian upgrade (high leverage)

After baseline ships: add a tiny personal "Chief of Staff" agent loop that runs every 2-4 hours:

1. Pull unresolved alerts + open todos + stale relationships.
2. Generate one concise brief:
   - "Handle now", "Schedule today", "Can wait"
3. Propose 1-tap draft replies for top 3 items.

This can run on local Ollama to keep marginal cost near zero.

