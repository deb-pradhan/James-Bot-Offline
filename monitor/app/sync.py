"""
Initial sync — fetch all Telegram dialogs and recent messages on startup.

Runs once per monitor startup to ensure the DB mirrors Telegram state.
Messages are flagged with is_sync=True so the consumer:
  - Skips auto-suggestion generation
  - Skips WebSocket event flooding
Dedup by telegram_msg_id means re-running sync is always safe.

Messages are processed oldest-first per dialog so that unresponded_count
and last_message_at end up in the correct final state.
"""

import asyncio
import logging

from telethon import TelegramClient
from telethon.tl.types import User, Chat, Channel
from telethon.errors import FloodWaitError

from app.relay import RedisRelay

logger = logging.getLogger(__name__)

# ── Sync config ──────────────────────────────────────────────────────────────
MAX_DIALOGS = 200  # Top N most recent dialogs
MESSAGES_PER_DIALOG = 30  # Last N messages per dialog
BATCH_DELAY = 0.05  # 50ms pause every 10 messages to pace the consumer


def _classify_entity(entity) -> tuple[str, str] | None:
    """Return (chat_type, chat_name) or None to skip."""
    if isinstance(entity, User):
        if entity.bot:
            return "bot", (entity.first_name or entity.username or f"Bot {entity.id}")
        return "personal_chat", (
            entity.first_name or entity.username or f"User {entity.id}"
        )

    if isinstance(entity, Chat):
        return "group", (entity.title or f"Group {entity.id}")

    if isinstance(entity, Channel):
        if entity.megagroup:
            return "supergroup", (entity.title or f"Supergroup {entity.id}")
        # Skip broadcast channels — they're not conversations
        return None

    return None


async def initial_sync(
    client: TelegramClient,
    relay: RedisRelay,
    user_id: str,
    self_tg_id: int,
):
    """Fetch all dialogs and recent messages, push through the consumer pipeline."""
    logger.info("[SYNC] Starting initial sync...")

    await relay.publish_status(
        user_id,
        "processing_status",
        {"message": "Syncing Telegram conversations..."},
    )

    try:
        dialogs = await client.get_dialogs(limit=MAX_DIALOGS)
        logger.info(f"[SYNC] Found {len(dialogs)} dialogs to sync")

        total_messages = 0
        synced_dialogs = 0

        for dialog in dialogs:
            entity = dialog.entity
            info = _classify_entity(entity)
            if info is None:
                continue  # Skip broadcast channels, unknown types

            chat_type, chat_name = info
            chat_id = str(entity.id)

            # Fetch recent messages (Telethon returns newest-first → reverse)
            try:
                messages = await client.get_messages(entity, limit=MESSAGES_PER_DIALOG)
                messages = list(reversed(messages))  # Oldest first
            except FloodWaitError as e:
                logger.warning(f"[SYNC] Flood wait {e.seconds}s for {chat_name}, waiting...")
                await asyncio.sleep(e.seconds + 1)
                try:
                    messages = await client.get_messages(entity, limit=MESSAGES_PER_DIALOG)
                    messages = list(reversed(messages))
                except Exception:
                    continue
            except Exception as e:
                logger.warning(f"[SYNC] Failed to fetch messages for {chat_name}: {e}")
                continue

            msg_count = 0
            for msg in messages:
                if not msg or not msg.text:
                    continue  # Skip media-only / service messages

                is_incoming = msg.sender_id != self_tg_id

                # Determine sender name
                if is_incoming:
                    try:
                        sender = await msg.get_sender()
                        sender_name = (
                            getattr(sender, "first_name", None)
                            or getattr(sender, "title", None)
                            or "Unknown"
                        )
                    except Exception:
                        sender_name = "Unknown"
                else:
                    sender_name = "self"

                message_data = {
                    "telegram_msg_id": msg.id,
                    "chat_id": chat_id,
                    "chat_name": chat_name,
                    "chat_type": chat_type,
                    "sender_id": str(msg.sender_id) if msg.sender_id else chat_id,
                    "sender_name": sender_name,
                    "text": msg.text,
                    "date": msg.date.isoformat(),
                    "is_incoming": is_incoming,
                    "is_sync": True,
                }

                await relay.publish_sync_message(user_id, message_data)
                msg_count += 1
                total_messages += 1

                # Pace every 10 messages
                if msg_count % 10 == 0:
                    await asyncio.sleep(BATCH_DELAY)

            synced_dialogs += 1

            if synced_dialogs % 20 == 0:
                logger.info(
                    f"[SYNC] Progress: {synced_dialogs}/{len(dialogs)} dialogs, "
                    f"{total_messages} messages"
                )
                await relay.publish_status(
                    user_id,
                    "processing_status",
                    {
                        "message": f"Syncing... {synced_dialogs}/{len(dialogs)} conversations"
                    },
                )

        logger.info(
            f"[SYNC] Complete: {synced_dialogs} dialogs, {total_messages} messages synced"
        )

        # Notify frontend with a single refresh event
        await relay.publish_status(
            user_id,
            "sync_complete",
            {
                "message": f"Sync complete — {synced_dialogs} conversations, {total_messages} messages",
                "dialogs": synced_dialogs,
                "messages": total_messages,
            },
        )

    except Exception as e:
        logger.error(f"[SYNC] Initial sync failed: {e}", exc_info=True)
        await relay.publish_status(
            user_id,
            "processing_status",
            {"message": "Sync failed — real-time monitoring continues"},
        )
