"""
Telegram Monitor Service — standalone process.

Connects to Telegram via Telethon (userbot API) and:
1. Listens for new incoming/outgoing messages
2. Relays them to the API via Redis pub/sub
3. Listens for "send message" commands from the API
4. Sends messages on behalf of the user
"""

import asyncio
import json
import logging
import sys

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.messages import SaveDraftRequest
from app.config import get_settings
from app.relay import RedisRelay
from app.handlers import register_handlers
from app.sync import initial_sync

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)
settings = get_settings()


async def start_monitor(
    session_string: str,
    api_id: int,
    api_hash: str,
    user_id: str,
    relay: RedisRelay,
):
    """Start the Telegram monitor for a specific user."""
    logger.info(f"[MONITOR] Starting Telegram client for user {user_id}")

    client = TelegramClient(StringSession(session_string), api_id, api_hash)
    await client.connect()

    if not await client.is_user_authorized():
        logger.error("[MONITOR] Session is not authorized. User needs to re-authenticate.")
        await relay.set_connected(user_id, False)
        await relay.publish_status(
            user_id,
            "telegram_status",
            {"connected": False, "message": "Session expired — re-authenticate in Settings"},
        )
        return

    me = await client.get_me()
    tg_display_name = " ".join(filter(None, [me.first_name, me.last_name])) or me.username
    logger.info(f"[MONITOR] Connected as {tg_display_name} (ID: {me.id})")

    await relay.set_connected(user_id, True)
    await relay.publish_status(
        user_id,
        "telegram_status",
        {"connected": True, "user_name": tg_display_name, "user_id": str(me.id)},
    )

    # Persist Telegram display name back to DB so summaries/ghostwriting use it
    # Small delay to ensure consumer is subscribed (avoids startup race)
    async def _push_name():
        await asyncio.sleep(3)
        await relay.redis.publish(
            f"telegram:update_user_name:{user_id}",
            json.dumps({"user_id": user_id, "name": tg_display_name}),
        )
    asyncio.create_task(_push_name())

    # Register event handlers (captures real-time messages going forward)
    register_handlers(client, relay, user_id, me.id)

    # Initial sync — fetch all existing dialogs + recent messages
    # This runs before the event loop so the DB has a full picture.
    # Dedup ensures real-time messages arriving during sync aren't doubled.
    await initial_sync(client, relay, user_id, me.id)

    # Listen for send commands in a separate task (user-scoped channel)
    async def handle_send_commands():
        async for raw in relay.subscribe_send_commands(user_id):
            try:
                data = json.loads(raw)
                chat_id = int(data["chat_id"])
                text = data["text"]
                mode = data.get("mode", "draft")

                if mode == "draft":
                    logger.info(f"[MONITOR] Saving draft in chat {chat_id}")
                    await client(SaveDraftRequest(peer=chat_id, message=text))
                    await relay.publish_status(
                        user_id,
                        "processing_status",
                        {"message": f"Draft saved in chat {chat_id} — open Telegram to review & send"},
                    )
                else:
                    logger.info(f"[MONITOR] Sending message to chat {chat_id}")
                    await client.send_message(chat_id, text)
                    await relay.publish_status(
                        user_id,
                        "processing_status",
                        {"message": f"Message sent to chat {chat_id}"},
                    )
            except Exception as e:
                logger.error(f"[MONITOR] Send command failed: {e}", exc_info=True)

    send_task = asyncio.create_task(handle_send_commands())

    logger.info("[MONITOR] Listening for messages and send commands...")

    try:
        await client.run_until_disconnected()
    finally:
        send_task.cancel()
        await relay.set_connected(user_id, False)
        logger.info("[MONITOR] Disconnected")


async def main():
    """
    Main entry point.

    Strategy:
    1. Check for session in env vars (TELEGRAM_SESSION_STRING)
    2. If not found, poll Redis for session data from the API auth flow
    3. Start monitor once session is available
    """
    relay = RedisRelay(settings.redis_url)
    await relay.connect()

    logger.info("[MONITOR] Monitor service started, looking for Telegram sessions...")

    # Check env var first
    if settings.telegram_session_string and settings.telegram_api_id:
        logger.info("[MONITOR] Using session from environment variables")
        await start_monitor(
            session_string=settings.telegram_session_string,
            api_id=settings.telegram_api_id,
            api_hash=settings.telegram_api_hash,
            user_id="default",
            relay=relay,
        )
        return

    # Poll Redis for sessions set by the API auth flow
    logger.info("[MONITOR] No env session found. Polling Redis for sessions...")

    # Reset all stale "connected" flags from previous instances.
    # If the container was killed, the finally block never ran.
    async for key in relay.redis.scan_iter("telegram:connected:*"):
        await relay.redis.set(key, "false")
    logger.info("[MONITOR] Reset stale connection flags")

    # Track users currently being started to prevent duplicate task creation
    # (race condition: task may not have set connected=true yet)
    starting_users: set[str] = set()
    active_tasks: dict[str, asyncio.Task] = {}

    while True:
        try:
            # Scan for all session keys
            keys = []
            async for key in relay.redis.scan_iter("telegram:session:*"):
                keys.append(key)

            for key in keys:
                user_id = key.split(":")[-1]

                # Skip if already connected OR currently starting
                if user_id in starting_users:
                    continue

                connected = await relay.redis.get(f"telegram:connected:{user_id}")
                if connected == "true":
                    continue  # Already monitoring

                session_data = await relay.get_session_data(user_id)
                if session_data:
                    logger.info(f"[MONITOR] Found session for user {user_id}, starting...")

                    # Mark as starting BEFORE creating task to prevent duplicates
                    starting_users.add(user_id)

                    async def wrapped_start(uid: str, sdata: dict):
                        try:
                            await start_monitor(
                                session_string=sdata["session_string"],
                                api_id=sdata["api_id"],
                                api_hash=sdata["api_hash"],
                                user_id=uid,
                                relay=relay,
                            )
                        finally:
                            # Always remove from starting set when done
                            starting_users.discard(uid)
                            active_tasks.pop(uid, None)

                    task = asyncio.create_task(wrapped_start(user_id, session_data))
                    active_tasks[user_id] = task

            # Clean up completed tasks (shouldn't happen often, but just in case)
            done_users = [uid for uid, t in active_tasks.items() if t.done()]
            for uid in done_users:
                starting_users.discard(uid)
                active_tasks.pop(uid, None)

        except Exception as e:
            logger.error(f"[MONITOR] Poll error: {e}")

        await asyncio.sleep(settings.session_poll_interval)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[MONITOR] Shutting down...")
