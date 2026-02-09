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
    pending_suggestion_id: str | None = None
    pending_suggestion_text: str | None = None


class UnrespondedListResponse(BaseModel):
    contacts: list[UnrespondedContact]
    total: int


# ── Cost Tracking ────────────────────────────────────────────────


class ServiceCost(BaseModel):
    service: str
    cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    api_calls: int


class OperationCost(BaseModel):
    operation: str
    cost_usd: float
    api_calls: int


class DailyCost(BaseModel):
    date: str  # YYYY-MM-DD
    cost_usd: float
    api_calls: int


class CostSummary(BaseModel):
    total_cost_usd: float
    today_cost_usd: float
    month_cost_usd: float
    total_llm_tokens_in: int
    total_llm_tokens_out: int
    total_embedding_tokens: int
    total_api_calls: int
    by_service: list[ServiceCost]
    by_operation: list[OperationCost]
    daily_costs: list[DailyCost]
