"""
Telegram event handlers for the monitor service.

Respects global pause: when `user:paused:{user_id}` is set in Redis,
real-time messages are NOT relayed to the consumer. They stay in Telegram
and will be picked up by the catch-up sync on resume.
"""

import logging
from datetime import datetime
from telethon import TelegramClient, events
from app.relay import RedisRelay

logger = logging.getLogger(__name__)


def register_handlers(
    client: TelegramClient,
    relay: RedisRelay,
    user_id: str,
    self_tg_id: int,
):
    """Register Telethon event handlers."""

    @client.on(events.NewMessage(incoming=True))
    async def on_incoming_message(event):
        """Handle incoming messages from other users."""
        try:
            # ── Pause guard ──
            if await relay.is_user_paused(user_id):
                logger.info(
                    f"[MONITOR] PAUSED — dropping incoming message from "
                    f"chat {event.chat_id} (will catch up on resume)"
                )
                return

            sender = await event.get_sender()
            chat = await event.get_chat()

            if not event.message.text:
                return  # Skip media-only messages for now

            message_data = {
                "telegram_msg_id": event.message.id,
                "chat_id": str(chat.id),
                "chat_name": (
                    getattr(chat, "first_name", "")
                    or getattr(chat, "title", "Unknown")
                ),
                "sender_id": str(sender.id),
                "sender_name": getattr(sender, "first_name", "Unknown"),
                "self_tg_id": str(self_tg_id),
                "text": event.message.text,
                "date": event.message.date.isoformat(),
                "is_incoming": True,
            }

            logger.info(
                f"[MONITOR] Incoming from {message_data['sender_name']}: "
                f"{event.message.text[:60]}..."
            )

            await relay.publish_new_message(user_id, message_data)

        except Exception as e:
            logger.error(f"[MONITOR] Error handling incoming message: {e}", exc_info=True)

    @client.on(events.NewMessage(outgoing=True))
    async def on_outgoing_message(event):
        """Handle outgoing messages (sent by James himself)."""
        try:
            # ── Pause guard ──
            if await relay.is_user_paused(user_id):
                logger.info(
                    f"[MONITOR] PAUSED — dropping outgoing message to "
                    f"chat {event.chat_id} (will catch up on resume)"
                )
                return

            chat = await event.get_chat()

            if not event.message.text:
                return

            message_data = {
                "telegram_msg_id": event.message.id,
                "chat_id": str(chat.id),
                "chat_name": (
                    getattr(chat, "first_name", "")
                    or getattr(chat, "title", "Unknown")
                ),
                "sender_id": str(self_tg_id),
                "sender_name": "self",
                "self_tg_id": str(self_tg_id),
                "text": event.message.text,
                "date": event.message.date.isoformat(),
                "is_incoming": False,
            }

            logger.info(
                f"[MONITOR] Outgoing to {message_data['chat_name']}: "
                f"{event.message.text[:60]}..."
            )

            await relay.publish_new_message(user_id, message_data)

        except Exception as e:
            logger.error(f"[MONITOR] Error handling outgoing message: {e}", exc_info=True)

    logger.info("[MONITOR] Event handlers registered")
