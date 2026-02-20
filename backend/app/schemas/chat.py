from pydantic import BaseModel


class QueryRequest(BaseModel):
    question: str
    contact_id: str | None = None  # Optional: scope to specific contact
    scope_type: str = "all"  # "all" | "dms" | "groups" | "custom"
    contact_ids: list[str] = []  # Used when scope_type == "custom"
    folder_id: int | None = None  # Optional Telegram folder id


class QueryResponse(BaseModel):
    answer: str
    sources: list["SourceChunk"]


class SourceChunk(BaseModel):
    contact_name: str | None = None
    document_name: str | None = None
    text_preview: str
    timestamp: str | None = None
    relevance_score: float


class ChatSuggestionsResponse(BaseModel):
    suggestions: list[str]
    personalized: bool  # True if based on actual user data


class TelegramFolder(BaseModel):
    folder_id: int
    title: str
    emoticon: str | None = None
    contact_ids: list[str]
    chat_count: int


class TelegramFoldersResponse(BaseModel):
    folders: list[TelegramFolder]
