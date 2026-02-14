---
name: Multi-Tenant User Isolation
overview: "Harden multi-tenant user isolation across all layers: database schema, Redis pub/sub channels, service-layer defense-in-depth, and vector retrieval safety — eliminating cross-user data leaks and process interference."
todos:
  - id: gap5-ws-cleanup
    content: Remove dead `telegram:status` global subscription from ws.py
    status: completed
  - id: gap3-defense-in-depth
    content: Add user_id ownership verification in generate_reply(), analyze_contact_style(), and _rechunk_and_embed_contact()
    status: completed
  - id: gap1-default-fallback
    content: "Fix 'default' user fallback: include telegram_user_id in message payload, match on User.telegram_user_id in consumer, reject ambiguous 'default' when multiple users exist"
    status: completed
  - id: gap6-unique-constraint
    content: Add unique constraint on (contact_id, telegram_msg_id) in messages table via Alembic migration
    status: completed
  - id: gap4-user-id-columns
    content: Add user_id FK column to ConversationChunk, DocumentChunk, Message tables — migration with backfill, model changes, insert-site updates, and retrieval query simplification
    status: completed
  - id: gap2-per-user-channels
    content: "Namespace Redis pub/sub channels by user_id: relay.py, main.py, message_consumer.py (pattern subscribe), suggestions.py, auto-generate publish"
    status: completed
isProject: false
---

# Multi-Tenant User Isolation Hardening

## Current State Audit

After a full codebase audit, the system already has reasonable user isolation in the API layer (JWT auth + WHERE clauses). However, there are **6 concrete isolation gaps** ranging from a critical data-leak risk to process-level interference issues. Here is the gap analysis and the fix plan.

---

## Gap 1 (CRITICAL): "default" User Fallback in Message Consumer

**File**: [backend/app/services/message_consumer.py](backend/app/services/message_consumer.py) (lines 381-389)

```python
if user_id_str == "default":
    stmt = select(User).where(User.telegram_session.isnot(None)).limit(1)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
```

When the monitor runs with `user_id="default"` (env-based session), the consumer resolves it to **the first user in the DB with a telegram_session**. In a multi-user deployment, this could attribute messages to the wrong user.

**Fix**: Replace the naive first-user lookup with a deterministic match. The monitor knows `me.id` (the Telegram user ID). Include it in the message payload, and in the consumer, match on `User.telegram_user_id` instead of picking the first row. Also require `user_id` to always be a valid UUID in production — log and drop messages with `"default"` if multiple users exist.

---

## Gap 2 (HIGH): Shared Redis Pub/Sub Channels

Three global channels create **process-level interference** between users:


| Channel                     | Issue                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `telegram:new_messages`     | All users' messages in one stream. One user's burst delays others.                  |
| `telegram:send_commands`    | All users' send/draft commands in one stream. Every monitor receives every command. |
| `telegram:update_user_name` | Minor, but also shared.                                                             |


**Fix**: Namespace all channels by `user_id`:

- `telegram:new_messages` -> `telegram:new_messages:{user_id}`
- `telegram:send_commands` -> `telegram:send_commands:{user_id}`
- `telegram:update_user_name` -> `telegram:update_user_name:{user_id}`

**Files to change**:

- [monitor/app/relay.py](monitor/app/relay.py) — `publish_new_message()`, `publish_sync_message()`, `subscribe_send_commands(user_id)`
- [monitor/app/main.py](monitor/app/main.py) — pass `user_id` to `subscribe_send_commands()`, push `_push_name` to user-specific channel
- [backend/app/services/message_consumer.py](backend/app/services/message_consumer.py) — `start_message_consumer()` must subscribe to per-user channels dynamically (pattern subscribe `telegram:new_messages:*` or one subscription per active user)
- [backend/app/api/suggestions.py](backend/app/api/suggestions.py) — publish to `telegram:send_commands:{user.id}` instead of global
- [backend/app/services/message_consumer.py](backend/app/services/message_consumer.py) — `_auto_generate_suggestion()` publish to `telegram:send_commands:{user_id}`

For the consumer, use Redis **pattern subscription** `telegram:new_messages:*` so it automatically picks up messages from any user without needing to track active users. The `user_id` is still in the payload for resolution, and now each monitor's send_commands subscription is scoped to its own user.

---

## Gap 3 (HIGH): Missing Defense-in-Depth in Service Functions

Several service functions receive `user_id` and `contact_id` as separate parameters but never verify the contact belongs to the user. While callers (API routes) already validate, a defensive check prevents future regressions.

**Files and changes**:

- [backend/app/services/response_generator.py](backend/app/services/response_generator.py) `generate_reply()` (line 49): After fetching contact, add `if contact.user_id != user_id: raise ValueError("Contact does not belong to user")`
- [backend/app/services/response_generator.py](backend/app/services/response_generator.py) `query_chat_history()`: Already passes `user_id` through to retrieval, which filters correctly. No change needed.
- [backend/app/services/style_analyzer.py](backend/app/services/style_analyzer.py) `analyze_contact_style()` (line 35): Add `assert contact.user_id == user_id` guard.
- [backend/app/services/message_consumer.py](backend/app/services/message_consumer.py) `_rechunk_and_embed_contact()` (line 160): After fetching contact, verify `contact.user_id == user_id`.

---

## Gap 4 (HIGH): Add `user_id` Column to Chunk and Message Tables

Currently, `ConversationChunk`, `DocumentChunk`, and `Message` lack a direct `user_id` column. Isolation depends entirely on JOINs through `Contact` or `Document`. This is fragile — any new query that forgets the JOIN leaks data across users.

**Schema changes** (new Alembic migration):

1. Add `user_id UUID REFERENCES users(id)` to `conversation_chunks`, `document_chunks`, and `messages`
2. Backfill from parent tables: `UPDATE conversation_chunks SET user_id = (SELECT user_id FROM contacts WHERE id = contact_id)`, etc.
3. Set `NOT NULL` after backfill
4. Add indexes: `CREATE INDEX ix_conv_chunks_user_id ON conversation_chunks(user_id)`, same for others

**Model changes**:

- [backend/app/models/chunk.py](backend/app/models/chunk.py) — add `user_id` column to both `ConversationChunk` and `DocumentChunk`
- [backend/app/models/message.py](backend/app/models/message.py) — add `user_id` column to `Message`

**Insert-site changes** — populate `user_id` on every insert:

- [backend/app/services/ingestion.py](backend/app/services/ingestion.py) — set `user_id` on `Message`, `ConversationChunk` during bulk import
- [backend/app/services/message_consumer.py](backend/app/services/message_consumer.py) — set `user_id` on `Message` in `_save_message()`, on `ConversationChunk` in `_rechunk_and_embed_contact()`
- [backend/app/api/ingest.py](backend/app/api/ingest.py) — set `user_id` on `DocumentChunk` during document/URL upload

**Query-site changes** — add direct `WHERE user_id = :user_id` filters:

- [backend/app/services/retrieval.py](backend/app/services/retrieval.py) — simplify conversation chunk queries to filter directly on `cc.user_id = :user_id` instead of JOINing through contacts (keep the JOIN for `display_name` only). Same for document chunks.

This is the most impactful change for vector DB isolation. After this, even if someone writes a raw query against `conversation_chunks` without a JOIN, the `user_id` column is right there to filter on.

---

## Gap 5 (MEDIUM): Stale Global WebSocket Subscription

**File**: [backend/app/api/ws.py](backend/app/api/ws.py) (line 71)

```python
await pubsub.subscribe("telegram:status")
```

Every authenticated WebSocket client subscribes to a global `telegram:status` channel. No code actually publishes to this channel (it's dead code), but if anything ever did, all users would see it.

**Fix**: Remove this line. All status events are already published to user-scoped `user:{user_id}:events` channels.

---

## Gap 6 (MEDIUM): Database-Level Constraints

Add a unique constraint on `(contact_id, telegram_msg_id)` in the `messages` table to enforce dedup at the DB level, not just application level. This prevents any race condition from creating duplicate messages.

**Migration**: `CREATE UNIQUE INDEX uq_messages_contact_telegram_msg ON messages(contact_id, telegram_msg_id) WHERE telegram_msg_id IS NOT NULL`

---

## Execution Order

Changes are ordered to minimize risk and allow incremental testing:

1. **Gap 5** — Remove dead `telegram:status` subscription (1 line, zero risk)
2. **Gap 3** — Add defense-in-depth ownership checks in services (small, safe additions)
3. **Gap 1** — Fix "default" user fallback (consumer + monitor changes)
4. **Gap 6** — Add unique constraint migration (DB only, no app code changes)
5. **Gap 4** — Add `user_id` columns + migration + backfill + update all insert/query sites
6. **Gap 2** — Per-user Redis channels (coordinated change across monitor, relay, consumer, API)

Gaps 5, 3, 1, 6 are quick wins. Gap 4 is the largest structural change. Gap 2 is the most coordinated change.