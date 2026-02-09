"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import type {
  Contact,
  QueryResponse,
  SourceChunk,
  ChatSuggestionsResponse,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  Loader2,
  User,
  FileText,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Bot,
  ArrowUp,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SourceChunk[];
}

const DEFAULT_SUGGESTIONS = [
  "Summarize this conversation",
  "What are the open questions?",
  "What was discussed recently?",
  "Any pending action items?",
];

interface QueryPanelProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  width: number;
}

export function QueryPanel({ collapsed, onCollapse, width }: QueryPanelProps) {
  const params = useParams<{ contactId?: string }>();
  const contactId = params?.contactId ?? null;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  // Scope state
  const [scopeContactId, setScopeContactId] = useState<string | null>(null);
  const [scopeEnabled, setScopeEnabled] = useState(true);
  const [scopeSearchOpen, setScopeSearchOpen] = useState(false);
  const [scopeSearchQuery, setScopeSearchQuery] = useState("");
  const scopeSearchRef = useRef<HTMLInputElement>(null);

  // Sync scope with route param when it changes
  useEffect(() => {
    if (contactId) {
      setScopeContactId(contactId);
      setScopeEnabled(true);
    }
  }, [contactId]);

  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch contact name when scoped
  const { data: contactData } = useQuery({
    queryKey: ["contact-info", scopeContactId],
    queryFn: () => api.contacts.get(scopeContactId!) as Promise<Contact>,
    enabled: !!scopeContactId,
    staleTime: 60_000,
  });

  // Search contacts for scope selector
  const { data: scopeSearchResults } = useQuery({
    queryKey: ["contacts-search", scopeSearchQuery],
    queryFn: () =>
      api.contacts.list({ search: scopeSearchQuery || undefined, limit: 10 }) as Promise<{
        contacts: Contact[];
        total: number;
      }>,
    enabled: scopeSearchOpen,
    staleTime: 10_000,
  });

  const contactName = contactData?.display_name ?? null;
  const effectiveScopeId = scopeContactId && scopeEnabled ? scopeContactId : undefined;

  // Fetch personalized suggestions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await api.chat.suggestions()) as ChatSuggestionsResponse;
        if (!cancelled) setSuggestions(res.suggestions);
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Focus scope search when opened
  useEffect(() => {
    if (scopeSearchOpen) {
      scopeSearchRef.current?.focus();
    }
  }, [scopeSearchOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = (await api.chat.query(
        question,
        effectiveScopeId,
      )) as QueryResponse;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.answer, sources: res.sources },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, something went wrong. Try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleScopeSelect = (contact: Contact) => {
    setScopeContactId(contact.id);
    setScopeEnabled(true);
    setScopeSearchOpen(false);
    setScopeSearchQuery("");
  };

  const handleScopeRemove = () => {
    setScopeContactId(null);
    setScopeEnabled(false);
    setScopeSearchOpen(false);
  };

  // ── Collapsed state ──
  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border-grid bg-surface-card pt-3">
        <button
          onClick={() => onCollapse(false)}
          className="text-ink-tertiary hover:text-ink-primary transition-colors"
          title="Open AI Assistant"
        >
          <PanelLeftOpen className="h-4 w-4" strokeWidth={1.5} />
        </button>
        <div className="mt-3 -rotate-90 whitespace-nowrap">
          <span className="text-[10px] text-ink-tertiary tracking-wider uppercase">
            AI Query
          </span>
        </div>
      </div>
    );
  }

  // ── Expanded state ──
  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="absolute inset-0 z-10 bg-black/40 lg:hidden"
        onClick={() => onCollapse(true)}
        aria-hidden="true"
      />
      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-border-grid bg-surface-card absolute inset-y-0 left-0 z-20 max-w-[calc(100vw-3rem)] lg:relative lg:z-auto lg:max-w-none"
        style={{ width: `${width}px` }}
      >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-grid px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} />
          <span className="text-sm text-ink-primary truncate">AI Assistant</span>
        </div>
        <button
          onClick={() => onCollapse(true)}
          className="text-ink-tertiary hover:text-ink-primary transition-colors shrink-0"
          title="Collapse panel"
        >
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* Scope indicator — now with search */}
      <div className="border-b border-border-element px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-tertiary shrink-0">Scope:</span>
          <div className="flex items-center gap-1 flex-1 min-w-0 flex-wrap">
            {scopeContactId && scopeEnabled ? (
              <Badge
                variant="outline"
                className="text-[10px] gap-1 cursor-pointer"
                onClick={() => {
                  setScopeEnabled(false);
                  setScopeContactId(null);
                }}
              >
                <User className="h-2.5 w-2.5" strokeWidth={1.5} />
                {contactName ?? "Loading..."}
                <X className="h-2.5 w-2.5 ml-0.5" strokeWidth={1.5} />
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className="text-[10px] gap-1"
              >
                All Chats
              </Badge>
            )}
            <button
              onClick={() => setScopeSearchOpen(!scopeSearchOpen)}
              className="flex items-center gap-0.5 text-[10px] text-ink-tertiary hover:text-primary transition-colors px-1"
              title="Search and add scope"
            >
              <Plus className="h-3 w-3" strokeWidth={1.5} />
              <span>{scopeContactId && scopeEnabled ? "Change" : "Add"}</span>
            </button>
          </div>
        </div>

        {/* Scope search dropdown */}
        {scopeSearchOpen && (
          <div className="mt-2 space-y-1">
            <Input
              ref={scopeSearchRef}
              placeholder="Search contacts..."
              value={scopeSearchQuery}
              onChange={(e) => setScopeSearchQuery(e.target.value)}
              className="text-xs h-7"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setScopeSearchOpen(false);
                  setScopeSearchQuery("");
                }
              }}
            />
            <div className="max-h-40 overflow-y-auto border border-border-element bg-surface-subtle">
              {/* "All Chats" option */}
              <button
                onClick={handleScopeRemove}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs text-ink-secondary hover:bg-surface-card transition-colors"
              >
                <Search className="h-3 w-3 text-ink-tertiary" strokeWidth={1.5} />
                All Chats
              </button>
              {(scopeSearchResults?.contacts ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleScopeSelect(c)}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs hover:bg-surface-card transition-colors",
                    c.id === scopeContactId ? "text-primary" : "text-ink-secondary"
                  )}
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center bg-accent text-primary text-[9px]">
                    {c.display_name.charAt(0).toUpperCase()}
                  </div>
                  <span className="truncate">{c.display_name}</span>
                  <span className="ml-auto text-[10px] text-ink-tertiary font-mono">{c.total_messages}</span>
                </button>
              ))}
              {scopeSearchResults?.contacts?.length === 0 && scopeSearchQuery && (
                <p className="px-2 py-2 text-[10px] text-ink-tertiary text-center">No contacts found</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0 px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center px-2 pt-12">
            <Search
              className="mb-3 h-8 w-8 text-ink-tertiary/30"
              strokeWidth={1.5}
            />
            <p className="text-xs text-ink-secondary">
              Ask anything about your chat history
            </p>
            {scopeContactId && scopeEnabled && contactName && (
              <p className="mt-1 text-[11px] text-ink-tertiary">
                Scoped to <span className="text-ink-secondary">{contactName}</span>
              </p>
            )}
            <div className="mt-4 flex flex-col gap-1.5 w-full">
              {suggestionsLoading ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-ink-tertiary mx-auto"
                  strokeWidth={1.5}
                />
              ) : (
                suggestions.slice(0, 4).map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="text-left text-[11px] text-ink-tertiary hover:text-ink-primary hover:bg-surface-subtle px-2 py-1.5 transition-colors truncate"
                  >
                    <Sparkles
                      className="inline mr-1.5 h-3 w-3 text-primary/50"
                      strokeWidth={1.5}
                    />
                    {s}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg, i) => (
              <div key={i}>
                {/* Role label */}
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-ink-tertiary uppercase tracking-wider">
                  {msg.role === "user" ? (
                    <User className="h-2.5 w-2.5" strokeWidth={1.5} />
                  ) : (
                    <Bot className="h-2.5 w-2.5" strokeWidth={1.5} />
                  )}
                  {msg.role === "user" ? "You" : "AI"}
                </div>

                {/* Message content */}
                <div
                  className={cn(
                    "px-3 py-2 text-xs leading-relaxed",
                    msg.role === "user"
                      ? "bg-surface-subtle text-ink-primary"
                      : "bg-surface-card border border-border-element text-ink-secondary",
                  )}
                >
                  {msg.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none text-xs break-words overflow-hidden [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}

                  {/* Sources */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-border-element pt-1.5">
                      {msg.sources.slice(0, 3).map((s, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-1 text-[10px] text-ink-tertiary"
                        >
                          {s.contact_name ? (
                            <Badge
                              variant="outline"
                              className="text-[9px] py-0 h-4"
                            >
                              <User className="mr-0.5 h-2 w-2" strokeWidth={1.5} />
                              {s.contact_name}
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[9px] py-0 h-4"
                            >
                              <FileText className="mr-0.5 h-2 w-2" strokeWidth={1.5} />
                              {s.document_name}
                            </Badge>
                          )}
                          <span className="truncate">
                            {s.text_preview.slice(0, 50)}...
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-xs text-ink-tertiary py-1">
                <Loader2
                  className="h-3 w-3 animate-spin text-primary"
                  strokeWidth={1.5}
                />
                Searching...
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input — arrow icon instead of search */}
      <form
        onSubmit={handleSubmit}
        className="flex gap-1.5 border-t border-border-grid p-2"
      >
        <Input
          placeholder={
            effectiveScopeId
              ? `Ask about ${contactName ?? "this chat"}...`
              : "Ask about all chats..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          className="text-xs h-8"
        />
        <Button
          type="submit"
          disabled={loading || !input.trim()}
          size="sm"
          className="h-8 w-8 p-0 shrink-0"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
          )}
        </Button>
      </form>
      </div>
    </>
  );
}
