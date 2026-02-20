// ── Auth ──
export interface User {
  id: string;
  email: string;
  name: string;
  telegram_user_id?: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: User;
}

// ── Contacts ──
export interface Contact {
  id: string;
  telegram_id: string;
  display_name: string;
  username?: string | null;
  chat_type: string;
  style_profile?: string | null;
  auto_respond: boolean;
  last_message_at?: string | null;
  unresponded_count: number;
  total_messages: number;
  created_at: string;
}

export interface Message {
  id: string;
  sender_type: "self" | "other";
  sender_name: string;
  content: string;
  sent_at: string;
  is_read: boolean;
  is_responded: boolean;
}

// ── Suggestions ──
export interface Suggestion {
  id: string;
  contact_id: string;
  contact_name?: string | null;
  suggested_response: string;
  context_used?: string | null;
  status: "pending" | "approved" | "rejected" | "sent";
  created_at: string;
  sent_at?: string | null;
}

// ── Documents ──
export interface Document {
  id: string;
  filename: string;
  doc_type: string;
  source_url?: string | null;
  scope: string;
  contact_id?: string | null;
  content_preview?: string | null;
  chunk_count: number;
  uploaded_at: string;
}

// ── Dashboard ──
export interface DashboardOverview {
  total_contacts: number;
  total_messages: number;
  total_documents: number;
  total_chunks: number;
  unresponded_count: number;
  pending_suggestions: number;
  telegram_connected: boolean;
}

export interface UnrespondedContact {
  contact_id: string;
  display_name: string;
  username?: string | null;
  unresponded_count: number;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  has_pending_suggestion: boolean;
  pending_suggestion_id?: string | null;
  pending_suggestion_text?: string | null;
}

// ── Critical Actions ──
export interface CriticalAction {
  contact_id: string;
  display_name: string;
  username?: string | null;
  chat_type: string;
  urgency: "critical" | "high" | "medium";
  urgency_score: number;
  reason: string;
  unresponded_count: number;
  hours_waiting: number;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  has_pending_suggestion: boolean;
  pending_suggestion_id?: string | null;
  pending_suggestion_text?: string | null;
}

export interface CriticalActionsResponse {
  actions: CriticalAction[];
  total: number;
  scope: string;
}

// ── Activity Summary ──
export interface ActivitySummaryResponse {
  summary: string;
  since: string;
  contacts_active: number;
  messages_count: number;
  scope: string;
  cached: boolean;
}

// ── Dashboard Scope ──
export interface ScopeOption {
  id: string;
  label: string;
  chat_type?: string | null;
  message_count: number;
}

// ── Query ──
export interface QueryResponse {
  answer: string;
  sources: SourceChunk[];
}

export interface ChatSuggestionsResponse {
  suggestions: string[];
  personalized: boolean;
}

export interface TelegramFolder {
  folder_id: number;
  title: string;
  emoticon?: string | null;
  contact_ids: string[];
  chat_count: number;
}

export interface SourceChunk {
  contact_name?: string | null;
  document_name?: string | null;
  text_preview: string;
  timestamp?: string | null;
  relevance_score: number;
}

// ── Costs ──
export interface ServiceCost {
  service: string;
  cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  api_calls: number;
}

export interface OperationCost {
  operation: string;
  cost_usd: number;
  api_calls: number;
}

export interface DailyCost {
  date: string;
  cost_usd: number;
  api_calls: number;
}

export interface CostSummary {
  total_cost_usd: number;
  today_cost_usd: number;
  month_cost_usd: number;
  total_llm_tokens_in: number;
  total_llm_tokens_out: number;
  total_embedding_tokens: number;
  total_api_calls: number;
  by_service: ServiceCost[];
  by_operation: OperationCost[];
  daily_costs: DailyCost[];
}

// ── Ingestion History ──
export interface IngestionHistoryItem {
  job_id: string;
  status: string;
  filename: string | null;
  file_hash: string | null;
  chat_date_start: string | null;
  chat_date_end: string | null;
  total_messages_in_file: number | null;
  messages_new: number | null;
  messages_skipped: number | null;
  total_chats: number | null;
  total_chunks: number | null;
  ingested_at: string;
}

export interface IngestionHistoryResponse {
  items: IngestionHistoryItem[];
  total: number;
}

// ── Ollama ──
export interface OllamaStatus {
  reachable: boolean;
  chat_models: OllamaModel[];
  embedding_models: OllamaModel[];
}

export interface OllamaModel {
  id: string;
  name: string;
  size: number;
  family: string;
  parameter_size: string;
}

// ── Embedding Provider ──
export interface EmbeddingProvider {
  id: "openai" | "voyageai" | "ollama";
  name: string;
  model: string;
  available: boolean;
  cost: string;
  models?: OllamaModel[];
}

export interface AvailableEmbeddingsResponse {
  providers: EmbeddingProvider[];
  current: { provider: string; model: string };
}

export interface LLMModel {
  id: string;
  name: string;
  description: string;
  provider: "anthropic" | "openai" | "ollama";
  tier: string;
  input_cost_per_m: number;
  output_cost_per_m: number;
}

// ── WebSocket Events ──
export interface WSEvent {
  type: string;
  data?: Record<string, unknown>;
  message?: string;
}
