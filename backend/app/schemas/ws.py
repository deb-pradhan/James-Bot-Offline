from pydantic import BaseModel
from typing import Any


class WSEvent(BaseModel):
    """WebSocket event sent to the client."""

    type: str  # ingestion_progress, new_message, suggestion_ready, etc.
    data: dict[str, Any] = {}
    message: str | None = None


# Event types:
# - ingestion_progress: step, progress, total, message
# - ingestion_complete: result dict
# - new_message: contact_id, contact_name, text_preview
# - suggestion_ready: suggestion_id, contact_id, contact_name
# - telegram_status: connected (bool), user_name
# - processing_status: status message
# - error: error message
