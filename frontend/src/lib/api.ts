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
  },

  // ── Dashboard ──
  dashboard: {
    overview: () => request("/api/dashboard/overview"),
    unresponded: () => request("/api/dashboard/unresponded"),
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
    generate: (contactId: string) =>
      request("/api/suggestions/generate", {
        method: "POST",
        body: JSON.stringify({ contact_id: contactId }),
      }),
    generateAll: () =>
      request("/api/suggestions/generate-all", { method: "POST" }),
    approve: (id: string) =>
      request(`/api/suggestions/${id}/approve`, { method: "POST" }),
    edit: (id: string, text: string) =>
      request(`/api/suggestions/${id}/edit`, {
        method: "POST",
        body: JSON.stringify({ text }),
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
      return request("/api/ingest/telegram", {
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
  },

  // ── Chat/Query ──
  chat: {
    query: (question: string, contactId?: string) =>
      request("/api/chat/query", {
        method: "POST",
        body: JSON.stringify({ question, contact_id: contactId }),
      }),
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
    updatePreferences: (prefs: Record<string, unknown>) =>
      request("/api/settings/preferences", {
        method: "PUT",
        body: JSON.stringify(prefs),
      }),
  },
};
