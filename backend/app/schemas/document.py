from pydantic import BaseModel
from datetime import datetime


class DocumentResponse(BaseModel):
    id: str
    filename: str
    doc_type: str
    source_url: str | None = None
    scope: str
    contact_id: str | None = None
    content_preview: str | None = None
    chunk_count: int = 0
    uploaded_at: datetime

    model_config = {"from_attributes": True}


class DocumentListResponse(BaseModel):
    documents: list[DocumentResponse]
    total: int
