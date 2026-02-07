from pydantic import BaseModel
from datetime import datetime


class ContactResponse(BaseModel):
    id: str
    telegram_id: str
    display_name: str
    username: str | None = None
    chat_type: str
    style_profile: str | None = None
    auto_respond: bool = False
    last_message_at: datetime | None = None
    unresponded_count: int = 0
    total_messages: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}


class ContactListResponse(BaseModel):
    contacts: list[ContactResponse]
    total: int


class ContactSettingsUpdate(BaseModel):
    auto_respond: bool | None = None
    display_name: str | None = None


class MessageResponse(BaseModel):
    id: str
    sender_type: str
    sender_name: str
    content: str
    sent_at: datetime
    is_read: bool
    is_responded: bool

    model_config = {"from_attributes": True}


class MessageListResponse(BaseModel):
    messages: list[MessageResponse]
    total: int
    contact: ContactResponse
