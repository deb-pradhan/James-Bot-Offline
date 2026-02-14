"""
WebSocket endpoint for real-time status updates.

Subscribes to Redis pub/sub for the authenticated user's events
and forwards them to the WebSocket client.
"""

import logging
import json
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis

from app.utils.auth import decode_access_token
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket connection for real-time events.

    Client sends auth token as first message:
    {"type": "auth", "token": "xxx"}

    Server then streams events:
    {"type": "ingestion_progress", "data": {...}, "message": "..."}
    """
    await websocket.accept()
    logger.info("[WS] Client connected")

    user_id = None
    redis_client = None
    pubsub = None

    try:
        # Wait for auth message
        auth_msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        auth_data = json.loads(auth_msg)

        if auth_data.get("type") != "auth" or not auth_data.get("token"):
            await websocket.send_json(
                {"type": "error", "message": "Send auth token first"}
            )
            await websocket.close()
            return

        user_id = decode_access_token(auth_data["token"])
        if not user_id:
            await websocket.send_json(
                {"type": "error", "message": "Invalid token"}
            )
            await websocket.close()
            return

        logger.info(f"[WS] Authenticated user: {user_id}")
        await websocket.send_json(
            {"type": "auth_success", "message": "Connected"}
        )

        # Subscribe to user's event channel
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(f"user:{user_id}:events")

        # Forward events from Redis to WebSocket
        async def forward_events():
            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        await websocket.send_text(message["data"])
                    except Exception:
                        break

        # Listen for client messages (ping/pong, close)
        async def listen_client():
            try:
                while True:
                    data = await websocket.receive_text()
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
            except WebSocketDisconnect:
                pass

        # Run both tasks concurrently
        await asyncio.gather(
            forward_events(),
            listen_client(),
            return_exceptions=True,
        )

    except WebSocketDisconnect:
        logger.info(f"[WS] Client disconnected: {user_id}")
    except asyncio.TimeoutError:
        logger.warning("[WS] Auth timeout — closing")
        await websocket.close()
    except Exception as e:
        logger.error(f"[WS] Error: {e}", exc_info=True)
    finally:
        if pubsub:
            await pubsub.unsubscribe()
            await pubsub.close()
        if redis_client:
            await redis_client.close()
        logger.info(f"[WS] Cleanup complete for {user_id}")
