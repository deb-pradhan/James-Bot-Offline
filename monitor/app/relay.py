"""
Redis relay for bidirectional communication between
the Telegram monitor and the API/dashboard.

Publishes: new messages, telegram status
Subscribes: send commands, session updates
"""

import json
import logging
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


class RedisRelay:
    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self.redis: aioredis.Redis | None = None
        self.pubsub: aioredis.client.PubSub | None = None

    async def connect(self):
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)
        self.pubsub = self.redis.pubsub()
        logger.info("[RELAY] Connected to Redis")

    async def close(self):
        if self.pubsub:
            await self.pubsub.close()
        if self.redis:
            await self.redis.close()
        logger.info("[RELAY] Redis connection closed")

    async def publish_new_message(self, user_id: str, message_data: dict):
        """Publish a new incoming Telegram message."""
        payload = json.dumps({"user_id": user_id, **message_data})
        await self.redis.publish("telegram:new_messages", payload)

        # Also publish to user's event channel for WebSocket
        event = {
            "type": "new_message",
            "data": message_data,
            "message": f"New message from {message_data.get('sender_name', 'Unknown')}",
        }
        await self.redis.publish(f"user:{user_id}:events", json.dumps(event))
        logger.info(f"[RELAY] Published new message from {message_data.get('sender_name')}")

    async def publish_status(self, user_id: str, event_type: str, data: dict):
        """Publish Telegram connection status."""
        payload = json.dumps({"type": event_type, "data": data})
        await self.redis.publish(f"user:{user_id}:events", payload)

    async def set_connected(self, user_id: str, connected: bool):
        """Set Telegram connection flag in Redis."""
        await self.redis.set(
            f"telegram:connected:{user_id}",
            "true" if connected else "false",
        )

    async def get_session_data(self, user_id: str) -> dict | None:
        """Get stored session data for a user from Redis."""
        data = await self.redis.get(f"telegram:session:{user_id}")
        if data:
            return json.loads(data)
        return None

    async def subscribe_send_commands(self):
        """Subscribe to send command channel and yield messages."""
        await self.pubsub.subscribe("telegram:send_commands")
        async for message in self.pubsub.listen():
            if message["type"] == "message":
                yield message["data"]

    async def subscribe_session_updates(self):
        """Subscribe to session update notifications."""
        sub = self.redis.pubsub()
        await sub.subscribe("telegram:session_updated")
        async for message in sub.listen():
            if message["type"] == "message":
                yield json.loads(message["data"])
