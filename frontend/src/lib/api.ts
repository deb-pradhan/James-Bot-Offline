/**
 * API client — handles auth headers, base URL, error handling.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Don't set Content-Type for FormData (browser sets it with boundary)
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(body.detail || "Request failed", res.status);
  }

  return res.json();
}

// ── Auth ──
export const api = {
  auth: {
    register: (data: { email: string; name: string; password: string }) =>
      request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    login: (data: { email: string; password: string }) =>
      request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    me: () => request("/api/auth/me"),
    forgotPassword: (data: { email: string }) =>
      request<{ message: string }>("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    resetPassword: (data: { token: string; password: string }) =>
      request<{ message: string }>("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },

  // ── Dashboard ──
  dashboard: {
    overview: () => request("/api/dashboard/overview"),
    unresponded: () => request("/api/dashboard/unresponded"),
    costs: () => request("/api/dashboard/costs"),
    criticalActions: () => request("/api/dashboard/critical-actions"),
    activitySummary: (force?: boolean) =>
      request(`/api/dashboard/activity-summary${force ? "?force=true" : ""}`),
    scopeOptions: () => request("/api/dashboard/scope-options"),
    updateScope: (scopeType: string, contactIds: string[] = []) =>
      request("/api/dashboard/scope", {
        method: "PUT",
        body: JSON.stringify({ scope_type: scopeType, contact_ids: contactIds }),
      }),
    markVisited: () =>
      request("/api/dashboard/mark-visited", { method: "POST" }),
  },

  // ── Contacts ──
  contacts: {
    list: (params?: { search?: string; sort?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set("search", params.search);
      if (params?.sort) qs.set("sort", params.sort);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      return request(`/api/contacts?${qs}`);
    },
    get: (id: string) => request(`/api/contacts/${id}`),
    messages: (id: string, params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      return request(`/api/contacts/${id}/messages?${qs}`);
    },
    summary: (id: string) =>
      request<{ summary: string; message_count: number }>(`/api/contacts/${id}/summary`),
    updateSettings: (id: string, data: { auto_respond?: boolean; display_name?: string }) =>
      request(`/api/contacts/${id}/settings`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  },

  // ── Suggestions ──
  suggestions: {
    list: (status?: string) => {
      const qs = status ? `?status=${status}` : "";
      return request(`/api/suggestions${qs}`);
    },
    generate: (contactId: string, userInstruction?: string) =>
      request("/api/suggestions/generate", {
        method: "POST",
        body: JSON.stringify({
          contact_id: contactId,
          ...(userInstruction ? { user_instruction: userInstruction } : {}),
        }),
      }),
    generateAll: () =>
      request("/api/suggestions/generate-all", { method: "POST" }),
    approve: (id: string, mode: "draft" | "send" = "draft") =>
      request(`/api/suggestions/${id}/approve?mode=${mode}`, { method: "POST" }),
    edit: (id: string, text: string, mode: "draft" | "send" = "draft") =>
      request(`/api/suggestions/${id}/edit`, {
        method: "POST",
        body: JSON.stringify({ text, mode }),
      }),
    reject: (id: string) =>
      request(`/api/suggestions/${id}`, { method: "DELETE" }),
  },

  // ── Ingest ──
  ingest: {
    telegram: (file: File, selfUserId?: string) => {
      const form = new FormData();
      form.append("file", file);
      if (selfUserId) form.append("self_user_id", selfUserId);
      return request<{
        job_id: string;
        status: string;
        message: string;
        duplicate_warning: string | null;
        overlap_warning: string | null;
      }>("/api/ingest/telegram", {
        method: "POST",
        body: form,
      });
    },
    document: (file: File, scope?: string, contactId?: string) => {
      const form = new FormData();
      form.append("file", file);
      if (scope) form.append("scope", scope);
      if (contactId) form.append("contact_id", contactId);
      return request("/api/ingest/document", {
        method: "POST",
        body: form,
      });
    },
    url: (data: { url: string; contact_id?: string; scope?: string }) =>
      request("/api/ingest/url", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    status: () =>
      request<{
        job_id: string;
        status: string;
        step: string | null;
        progress: number | null;
        total: number | null;
        message: string | null;
        result: Record<string, number> | null;
        globally_paused: boolean;
        paused_at: string | null;
      } | null>("/api/ingest/active"),
    pause: () =>
      request<{ status: string; message: string }>("/api/ingest/pause", {
        method: "POST",
      }),
    resume: () =>
      request<{ status: string; message: string }>("/api/ingest/resume", {
        method: "POST",
      }),
    stopAnalysis: () =>
      request<{ status: string; message: string }>("/api/ingest/stop-analysis", {
        method: "POST",
      }),
    stop: () =>
      request<{ status: string; message: string }>("/api/ingest/stop", {
        method: "POST",
      }),
    reset: () =>
      request<{ status: string; message: string }>("/api/ingest/reset", {
        method: "POST",
      }),
    history: (params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      return request<{
        items: Array<{
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
        }>;
        total: number;
      }>(`/api/ingest/history?${qs}`);
    },
  },

  // ── Chat/Query ──
  chat: {
    query: (
      question: string,
      opts?: {
        contactId?: string;
        scopeType?: "all" | "dms" | "groups" | "custom";
        contactIds?: string[];
        folderId?: number;
      }
    ) =>
      request("/api/chat/query", {
        method: "POST",
        body: JSON.stringify({
          question,
          contact_id: opts?.contactId,
          scope_type: opts?.scopeType ?? "all",
          contact_ids: opts?.contactIds ?? [],
          folder_id: opts?.folderId,
        }),
      }),
    suggestions: () => request("/api/chat/suggestions"),
    folders: () =>
      request<{
        folders: Array<{
          folder_id: number;
          title: string;
          emoticon?: string | null;
          contact_ids: string[];
          chat_count: number;
        }>;
      }>("/api/chat/folders"),
  },

  // ── Documents ──
  documents: {
    list: (params?: { scope?: string; contact_id?: string }) => {
      const qs = new URLSearchParams();
      if (params?.scope) qs.set("scope", params.scope);
      if (params?.contact_id) qs.set("contact_id", params.contact_id);
      return request(`/api/documents?${qs}`);
    },
    delete: (id: string) =>
      request(`/api/documents/${id}`, { method: "DELETE" }),
  },

  // ── Settings ──
  settings: {
    requestTelegramCode: (data: { api_id: number; api_hash: string; phone: string }) =>
      request("/api/settings/telegram/request-code", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    verifyTelegramCode: (data: { code: string; phone_code_hash?: string }) =>
      request("/api/settings/telegram/verify-code", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    telegramStatus: () => request("/api/settings/telegram/status"),
    getPreferences: () =>
      request<{ settings: Record<string, unknown> }>("/api/auth/me").then(
        (user: Record<string, unknown>) =>
          (user.settings as Record<string, unknown>) ?? {}
      ),
    updatePreferences: (prefs: Record<string, unknown>) =>
      request("/api/settings/preferences", {
        method: "PUT",
        body: JSON.stringify(prefs),
      }),
    availableModels: () =>
      request<{
        models: Array<{
          id: string;
          name: string;
          description: string;
          provider: "anthropic" | "openai" | "ollama";
          tier: string;
          input_cost_per_m: number;
          output_cost_per_m: number;
        }>;
        current: string;
        default: string;
      }>("/api/settings/available-models"),
    validateApiKey: (apiKey: string, provider: "anthropic" | "openai" = "anthropic") =>
      request<{ valid: boolean; message: string }>("/api/settings/validate-api-key", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey, provider }),
      }),
    getAiStatus: () =>
      request<{
        ai_enabled: boolean;
        has_custom_api_key: boolean;
        has_anthropic_api_key: boolean;
        has_openai_api_key: boolean;
        can_use_embeddings: boolean;
        active_llm_provider: "anthropic" | "openai" | "ollama" | null;
        has_ollama: boolean;
        ollama_model_count: number;
        embedding_provider: "openai" | "voyageai" | "ollama";
      }>("/api/settings/ai-status"),
    ollamaStatus: () =>
      request<{
        reachable: boolean;
        chat_models: Array<{
          id: string;
          name: string;
          size: number;
          family: string;
          parameter_size: string;
        }>;
        embedding_models: Array<{
          id: string;
          name: string;
          size: number;
          family: string;
          parameter_size: string;
        }>;
      }>("/api/settings/ollama/status"),
    availableEmbeddings: () =>
      request<{
        providers: Array<{
          id: "openai" | "voyageai" | "ollama";
          name: string;
          model: string;
          available: boolean;
          cost: string;
          models?: Array<{ id: string; name: string }>;
        }>;
        current: { provider: string; model: string };
      }>("/api/settings/available-embeddings"),
    reembed: () =>
      request<{ status: string; message: string; total?: number }>(
        "/api/settings/reembed",
        { method: "POST" }
      ),
    deleteAllData: (options: { confirm: boolean; keepAccount?: boolean }) =>
      request<{ status: string; message: string }>("/api/settings/delete-all-data", {
        method: "DELETE",
        body: JSON.stringify({
          confirm: options.confirm,
          keep_account: options.keepAccount ?? true,
        }),
      }),
  },
};
