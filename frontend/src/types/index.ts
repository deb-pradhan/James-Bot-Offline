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
}

// ── Query ──
export interface QueryResponse {
  answer: string;
  sources: SourceChunk[];
}

export interface SourceChunk {
  contact_name?: string | null;
  document_name?: string | null;
  text_preview: string;
  timestamp?: string | null;
  relevance_score: number;
}

// ── WebSocket Events ──
export interface WSEvent {
  type: string;
  data?: Record<string, unknown>;
  message?: string;
}
