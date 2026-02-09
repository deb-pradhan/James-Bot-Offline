"""
Parser for Telegram Desktop JSON export format.

Handles both:
- Full account export: {"chats": {"list": [...]}}
- Single chat export: {"name": "...", "messages": [...]}

The `text` field in messages can be a string or a list of
mixed strings/objects (for formatted text).
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from collections import Counter

logger = logging.getLogger(__name__)


@dataclass
class ParsedMessage:
    telegram_msg_id: int
    sender_name: str
    sender_id: str
    text: str
    sent_at: datetime
    raw_data: dict = field(default_factory=dict)


@dataclass
class ParsedChat:
    chat_name: str
    chat_type: str
    telegram_chat_id: str
    messages: list[ParsedMessage] = field(default_factory=list)


@dataclass
class ExportMetadata:
    """Summary info about the parsed export for history tracking."""
    chat_date_start: datetime | None = None
    chat_date_end: datetime | None = None
    total_messages: int = 0
    total_chats: int = 0


def extract_text(text_field) -> str:
    """Extract plain text from Telegram's text field (can be str or list)."""
    if isinstance(text_field, str):
        return text_field
    if isinstance(text_field, list):
        parts = []
        for part in text_field:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                parts.append(part.get("text", ""))
        return "".join(parts)
    return ""


def parse_telegram_export(data: dict) -> tuple[list[ParsedChat], str, ExportMetadata]:
    """
    Parse Telegram export JSON.

    Returns:
        (list of parsed chats, detected self user ID, export metadata)
    """
    chats_data = []

    # Detect format
    if "chats" in data and isinstance(data["chats"], dict) and "list" in data["chats"]:
        chats_data = data["chats"]["list"]
        logger.info(f"[INGEST] Detected full account export with {len(chats_data)} chats")
    elif "messages" in data:
        chats_data = [data]
        logger.info("[INGEST] Detected single chat export")
    else:
        raise ValueError(
            "Unrecognized Telegram export format. Expected 'chats.list' or 'messages' key."
        )

    # Count sender IDs across all personal chats to auto-detect self
    sender_counter: Counter = Counter()
    chat_appearances: Counter = Counter()  # How many different chats each sender appears in

    for chat in chats_data:
        seen_in_chat: set[str] = set()
        for msg in chat.get("messages", []):
            sender_id = msg.get("from_id", "")
            if msg.get("type") == "message" and sender_id:
                sender_counter[sender_id] += 1
                if sender_id not in seen_in_chat:
                    chat_appearances[sender_id] += 1
                    seen_in_chat.add(sender_id)

    # Self user appears in the MOST chats (they're in every conversation)
    self_user_id = ""
    if chat_appearances:
        self_user_id = chat_appearances.most_common(1)[0][0]
        logger.info(
            f"[INGEST] Auto-detected self user ID: {self_user_id} "
            f"(appears in {chat_appearances[self_user_id]} chats)"
        )

    # Parse each chat
    parsed_chats: list[ParsedChat] = []
    skipped_msgs = 0

    for chat in chats_data:
        messages: list[ParsedMessage] = []

        for msg in chat.get("messages", []):
            # Skip service messages (joins, photo changes, etc.)
            if msg.get("type") != "message":
                continue

            text = extract_text(msg.get("text", ""))
            if not text.strip():
                skipped_msgs += 1
                continue

            try:
                sent_at = datetime.fromisoformat(msg["date"])
            except (KeyError, ValueError):
                # Fallback to unix timestamp
                unix_ts = msg.get("date_unixtime")
                if unix_ts:
                    sent_at = datetime.fromtimestamp(int(unix_ts))
                else:
                    skipped_msgs += 1
                    continue

            messages.append(
                ParsedMessage(
                    telegram_msg_id=msg.get("id", 0),
                sender_name=msg.get("from") or "Unknown",
                sender_id=msg.get("from_id") or "",
                    text=text,
                    sent_at=sent_at,
                    raw_data=msg,
                )
            )

        if messages:
            parsed_chats.append(
                ParsedChat(
                    chat_name=chat.get("name") or "Unknown",
                    chat_type=chat.get("type") or "personal_chat",
                    telegram_chat_id=str(chat.get("id", "")),
                    messages=messages,
                )
            )

    total_msgs = sum(len(c.messages) for c in parsed_chats)
    logger.info(
        f"[INGEST] Parsed {len(parsed_chats)} chats, "
        f"{total_msgs} messages, {skipped_msgs} skipped (no text/date)"
    )

    # Compute date range across all messages
    all_dates = [m.sent_at for c in parsed_chats for m in c.messages]
    metadata = ExportMetadata(
        chat_date_start=min(all_dates) if all_dates else None,
        chat_date_end=max(all_dates) if all_dates else None,
        total_messages=total_msgs,
        total_chats=len(parsed_chats),
    )

    return parsed_chats, self_user_id, metadata
