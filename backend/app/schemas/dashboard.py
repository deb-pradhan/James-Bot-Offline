from pydantic import BaseModel
from datetime import datetime


class DashboardOverview(BaseModel):
    total_contacts: int
    total_messages: int
    total_documents: int
    total_chunks: int
    unresponded_count: int
    pending_suggestions: int
    telegram_connected: bool


class UnrespondedContact(BaseModel):
    contact_id: str
    display_name: str
    username: str | None = None
    unresponded_count: int
    last_message_at: datetime | None = None
    last_message_preview: str | None = None
    has_pending_suggestion: bool = False


class UnrespondedListResponse(BaseModel):
    contacts: list[UnrespondedContact]
    total: int
