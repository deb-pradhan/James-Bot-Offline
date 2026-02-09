from pydantic import BaseModel
from datetime import datetime


class SuggestionResponse(BaseModel):
    id: str
    contact_id: str
    contact_name: str | None = None
    suggested_response: str
    context_used: str | None = None
    status: str
    created_at: datetime
    sent_at: datetime | None = None

    model_config = {"from_attributes": True}


class SuggestionListResponse(BaseModel):
    suggestions: list[SuggestionResponse]
    total: int


class GenerateRequest(BaseModel):
    contact_id: str
    user_instruction: str | None = None  # Optional custom instruction to guide AI generation


class EditSuggestionRequest(BaseModel):
    text: str
    mode: str = "draft"  # "draft" or "send"
