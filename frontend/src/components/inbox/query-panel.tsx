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

export function QueryPanel() {
  const params = useParams<{ contactId?: string }>();
  const contactId = params?.contactId ?? null;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scopeEnabled, setScopeEnabled] = useState(true);

  // Auto-collapse on mobile
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setCollapsed(true);
    }
  }, []);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch contact name when scoped
  const { data: contactData } = useQuery({
    queryKey: ["contact-info", contactId],
    queryFn: () => api.contacts.get(contactId!) as Promise<Contact>,
    enabled: !!contactId,
    staleTime: 60_000,
  });

  const contactName = contactData?.display_name ?? null;
  const effectiveContactId = contactId && scopeEnabled ? contactId : undefined;

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
        effectiveContactId,
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

  // ── Collapsed state ──
  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border-grid bg-surface-card pt-3">
        <button
          onClick={() => setCollapsed(false)}
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
        onClick={() => setCollapsed(true)}
        aria-hidden="true"
      />
      <div className="flex w-80 max-w-[calc(100vw-3rem)] shrink-0 flex-col overflow-hidden border-r border-border-grid bg-surface-card absolute inset-y-0 left-0 z-20 lg:relative lg:z-auto lg:w-96 lg:max-w-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-grid px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} />
          <span className="text-sm text-ink-primary truncate">AI Assistant</span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="text-ink-tertiary hover:text-ink-primary transition-colors shrink-0"
          title="Collapse panel"
        >
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* Scope indicator */}
      {contactId && (
        <div className="flex items-center gap-2 border-b border-border-element px-3 py-1.5">
          <span className="text-[11px] text-ink-tertiary">Scope:</span>
          {scopeEnabled ? (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 cursor-pointer"
              onClick={() => setScopeEnabled(false)}
            >
              <User className="h-2.5 w-2.5" strokeWidth={1.5} />
              {contactName ?? "Loading..."}
              <X className="h-2.5 w-2.5 ml-0.5" strokeWidth={1.5} />
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer"
              onClick={() => setScopeEnabled(true)}
            >
              All Chats
            </Badge>
          )}
        </div>
      )}

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
            {contactId && scopeEnabled && contactName && (
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

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex gap-1.5 border-t border-border-grid p-2"
      >
        <Input
          placeholder={
            effectiveContactId
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
            <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
        </Button>
      </form>
      </div>
    </>
  );
}
