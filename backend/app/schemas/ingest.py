from pydantic import BaseModel


class IngestResponse(BaseModel):
    job_id: str
    status: str
    message: str
    duplicate_warning: str | None = None
    overlap_warning: str | None = None


class IngestStatusResponse(BaseModel):
    job_id: str
    status: str  # queued, processing, complete, failed
    step: str | None = None
    progress: int | None = None
    total: int | None = None
    message: str | None = None
    result: dict | None = None


class UrlIngestRequest(BaseModel):
    url: str
    contact_id: str | None = None
    scope: str = "general"  # "general" or "contact"


class IngestionHistoryItem(BaseModel):
    job_id: str
    status: str
    filename: str | None = None
    file_hash: str | None = None
    chat_date_start: str | None = None
    chat_date_end: str | None = None
    total_messages_in_file: int | None = None
    messages_new: int | None = None
    messages_skipped: int | None = None
    total_chats: int | None = None
    total_chunks: int | None = None
    ingested_at: str


class IngestionHistoryResponse(BaseModel):
    items: list[IngestionHistoryItem]
    total: int
