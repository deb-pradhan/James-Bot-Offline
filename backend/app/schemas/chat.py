from pydantic import BaseModel


class QueryRequest(BaseModel):
    question: str
    contact_id: str | None = None  # Optional: scope to specific contact


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
