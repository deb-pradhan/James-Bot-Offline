from pydantic import BaseModel


class IngestResponse(BaseModel):
    job_id: str
    status: str
    message: str


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
