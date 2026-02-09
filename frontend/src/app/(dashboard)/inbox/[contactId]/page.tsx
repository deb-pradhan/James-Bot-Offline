"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useWebSocket } from "@/hooks/use-websocket";
import type { Contact, Message, Suggestion, WSEvent } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sparkles,
  Send,
  X,
  Pencil,
  Bot,
  FileDown,
  AlignLeft,
  Loader2,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import Link from "next/link";

export default function ConversationPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const queryClient = useQueryClient();
  const [editText, setEditText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(true);

  // Real-time: invalidate messages + suggestions on new events
  const handleWsEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "new_message" || event.type === "sync_complete") {
        queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
        queryClient.invalidateQueries({ queryKey: ["contacts"] });
      }
      if (event.type === "suggestion_ready") {
        queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      }
    },
    [queryClient, contactId],
  );
  useWebSocket(handleWsEvent);

  // Fetch messages
  const { data: messagesData, isLoading: msgsLoading } = useQuery({
    queryKey: ["messages", contactId],
    queryFn: () =>
      api.contacts.messages(contactId, { limit: 100 }) as Promise<{
        messages: Message[];
        total: number;
        contact: Contact;
      }>,
    enabled: !!contactId,
  });

  // Fetch pending suggestions for this contact
  const { data: suggestionsData } = useQuery({
    queryKey: ["suggestions", contactId],
    queryFn: async () => {
      const res = (await api.suggestions.list("pending")) as {
        suggestions: Suggestion[];
      };
      return res.suggestions.filter((s) => s.contact_id === contactId);
    },
    enabled: !!contactId,
  });

  // Fetch chat summary on load
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ["contact-summary", contactId],
    queryFn: () => api.contacts.summary(contactId),
    enabled: !!contactId,
    staleTime: 5 * 60 * 1000, // cache 5 min
  });

  const contact = messagesData?.contact;
  const messages = messagesData?.messages ?? [];
  const suggestions = suggestionsData ?? [];

  // Auto-scroll to bottom on new messages
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.suggestions.generate(contactId);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      toast.success("Response generated!");
    } catch {
      toast.error("Failed to generate response");
    } finally {
      setGenerating(false);
    }
  };

  const handleDraft = async (id: string) => {
    try {
      await api.suggestions.approve(id, "draft");
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
      toast.success("Draft saved — open Telegram to review & send");
    } catch {
      toast.error("Failed to save draft");
    }
  };

  const handleSendNow = async (id: string) => {
    try {
      await api.suggestions.approve(id, "send");
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
      toast.success("Message sent!");
    } catch {
      toast.error("Failed to send");
    }
  };

  const handleEditSubmit = async (id: string, mode: "draft" | "send") => {
    try {
      await api.suggestions.edit(id, editText, mode);
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
      const action = mode === "draft" ? "Draft saved" : "Message sent";
      toast.success(action);
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleReject = async (id: string) => {
    try {
      await api.suggestions.reject(id);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
    } catch {
      toast.error("Failed to reject");
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden -mx-[--content-padding] -mb-[--content-padding] -mt-[--content-padding]">
      {/* ── Sticky Header ── */}
      <div className="shrink-0 flex items-center gap-2 border-b border-border-grid px-3 py-2.5 bg-surface-card">
        <Link
          href="/inbox"
          className="flex h-8 w-8 shrink-0 items-center justify-center text-ink-tertiary hover:text-ink-primary transition-colors"
          aria-label="Back to inbox"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        </Link>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-accent text-primary text-xs">
          {contact?.display_name?.charAt(0) ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm text-ink-primary">
            {contact?.display_name ?? "Loading..."}
          </h2>
          <p className="text-xs text-ink-tertiary">
            <span className="font-mono">{contact?.total_messages ?? 0}</span>{" "}
            messages
            {contact?.unresponded_count
              ? ` · ${contact.unresponded_count} unresponded`
              : ""}
          </p>
        </div>
        <Button
          onClick={handleGenerate}
          disabled={generating}
          size="sm"
          className="shrink-0"
        >
          <Sparkles className="h-4 w-4 sm:mr-2" strokeWidth={1.5} />
          <span className="hidden sm:inline">
            {generating ? "Generating..." : "Generate Response"}
          </span>
        </Button>
      </div>

      {/* ── Collapsible Chat Summary — pinned below header ── */}
      {(summaryLoading || summaryData) && (
        <div className="shrink-0 border-b border-border-element bg-surface-subtle">
          <button
            onClick={() => setSummaryExpanded((p) => !p)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-subtle/80 transition-colors"
          >
            <AlignLeft className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" strokeWidth={1.5} />
            <span className="text-label text-ink-tertiary flex-1">Chat Summary</span>
            {summaryLoading && (
              <Loader2 className="h-3 w-3 animate-spin text-ink-tertiary" />
            )}
            {summaryData && (
              summaryExpanded ? (
                <ChevronUp className="h-3 w-3 text-ink-tertiary" strokeWidth={1.5} />
              ) : (
                <ChevronDown className="h-3 w-3 text-ink-tertiary" strokeWidth={1.5} />
              )
            )}
          </button>
          {summaryExpanded && summaryData && (
            <div className="px-4 pb-3">
              <p className="text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap line-clamp-4">
                {summaryData.summary}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-ink-tertiary font-mono">
                  Based on {summaryData.message_count} messages
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Scrollable Messages ── */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 sm:px-4 py-4 space-y-3">
          {msgsLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <Skeleton
                key={i}
                className={cn("h-12 w-3/4", i % 2 === 0 ? "" : "ml-auto")}
              />
            ))
          ) : messages.length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-tertiary">
              No messages yet
            </p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex",
                  msg.sender_type === "self" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] sm:max-w-[70%] px-3 sm:px-4 py-2.5",
                    msg.sender_type === "self"
                      ? "bg-primary text-white"
                      : "bg-surface-subtle text-ink-primary"
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  <p
                    className={cn(
                      "mt-1 text-[10px] font-mono",
                      msg.sender_type === "self"
                        ? "text-white/50"
                        : "text-ink-tertiary"
                    )}
                  >
                    {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* ── Suggestion Cards — pinned at bottom ── */}
      {suggestions.length > 0 && (
        <div className="shrink-0 max-h-[40%] overflow-y-auto border-t border-border-grid bg-surface-card p-3 space-y-3">
          {suggestions.map((s) => (
            <Card key={s.id} className="border-primary/30 bg-accent">
              <CardContent className="py-3">
                <div className="mb-2 flex items-center gap-2">
                  <Bot className="h-3.5 w-3.5 text-primary" strokeWidth={1.5} />
                  <span className="text-label text-primary">AI Suggested Response</span>
                </div>

                {editingId === s.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleEditSubmit(s.id, "draft")}
                      >
                        <FileDown className="mr-1 h-3 w-3" strokeWidth={1.5} /> Save as Draft
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditSubmit(s.id, "send")}
                      >
                        <Send className="mr-1 h-3 w-3" strokeWidth={1.5} /> Send Now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-ink-primary whitespace-pre-wrap">
                      {s.suggested_response}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleDraft(s.id)}
                      >
                        <FileDown className="mr-1 h-3 w-3" strokeWidth={1.5} /> Save as Draft
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSendNow(s.id)}
                      >
                        <Send className="mr-1 h-3 w-3" strokeWidth={1.5} /> Send Now
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditText(s.suggested_response);
                          setEditingId(s.id);
                        }}
                      >
                        <Pencil className="mr-1 h-3 w-3" strokeWidth={1.5} /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleReject(s.id)}
                      >
                        <X className="mr-1 h-3 w-3" strokeWidth={1.5} /> Reject
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
