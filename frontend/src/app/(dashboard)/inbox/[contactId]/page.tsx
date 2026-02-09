"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useWebSocket } from "@/hooks/use-websocket";
import { usePreferences } from "@/hooks/use-preferences";
import type { Contact, Message, Suggestion, WSEvent } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  ArrowUp,
  RefreshCw,
  MessageSquare,
  Briefcase,
  Minus,
  HelpCircle,
  ThumbsDown,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import Link from "next/link";

/* ── Tone Presets ── */
const TONE_PRESETS = [
  { label: "Casual", icon: MessageSquare, instruction: "Keep it casual and friendly, like texting a friend" },
  { label: "Professional", icon: Briefcase, instruction: "Be professional and polished, clear and concise" },
  { label: "Brief", icon: Minus, instruction: "Keep it very short — one or two sentences max" },
  { label: "Follow up", icon: RefreshCw, instruction: "Follow up on the last topic, show continued interest" },
  { label: "Ask more", icon: HelpCircle, instruction: "Ask for more details or clarification about what they said" },
  { label: "Decline", icon: ThumbsDown, instruction: "Politely decline or say no to what they're asking" },
];

export default function ConversationPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const queryClient = useQueryClient();
  const { prefs, updatePreference } = usePreferences();

  const [editText, setEditText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(true);

  // Composer state
  const [instruction, setInstruction] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);

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
    staleTime: 5 * 60 * 1000,
  });

  const contact = messagesData?.contact;
  const messages = messagesData?.messages ?? [];
  const suggestions = suggestionsData ?? [];

  // Auto-scroll to bottom on new messages
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Focus instruction input when composer expands
  useEffect(() => {
    if (composerExpanded) {
      instructionRef.current?.focus();
    }
  }, [composerExpanded]);

  const handleGenerate = async (customInstruction?: string) => {
    const instr = customInstruction || instruction.trim() || undefined;
    setGenerating(true);
    try {
      await api.suggestions.generate(contactId, instr);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      setInstruction("");
      setComposerExpanded(false);
      toast.success("Response generated!");
    } catch {
      toast.error("Failed to generate response");
    } finally {
      setGenerating(false);
    }
  };

  const handleTonePreset = (presetInstruction: string) => {
    setInstruction(presetInstruction);
    setComposerExpanded(true);
    // Auto-generate immediately with this preset
    handleGenerate(presetInstruction);
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

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
    if (e.key === "Escape") {
      setComposerExpanded(false);
      setInstruction("");
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

        {/* Toggle Controls */}
        <div className="flex items-center gap-4 shrink-0">
          <label className="flex items-center gap-1.5 cursor-pointer select-none group relative">
            <Switch
              checked={prefs.auto_generate}
              onCheckedChange={(checked) =>
                updatePreference("auto_generate", checked)
              }
            />
            <div className="hidden sm:flex flex-col leading-none">
              <span className="text-[10px] uppercase tracking-wider text-ink-tertiary">
                Auto-reply
              </span>
              <span className="text-[9px] text-ink-tertiary/60">
                {prefs.auto_generate ? "Generating on new msgs" : "Manual only"}
              </span>
            </div>
            {/* Mobile-only tooltip on hover */}
            <div className="sm:hidden absolute -bottom-8 right-0 whitespace-nowrap bg-surface-subtle border border-border-element px-2 py-1 text-[10px] text-ink-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30">
              {prefs.auto_generate ? "Auto-reply ON" : "Auto-reply OFF"}
            </div>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none group relative">
            <Switch
              checked={prefs.auto_draft}
              onCheckedChange={(checked) =>
                updatePreference("auto_draft", checked)
              }
            />
            <div className="hidden sm:flex flex-col leading-none">
              <span className="text-[10px] uppercase tracking-wider text-ink-tertiary">
                Auto-draft
              </span>
              <span className="text-[9px] text-ink-tertiary/60">
                {prefs.auto_draft ? "Saving drafts to Telegram" : "Pending review"}
              </span>
            </div>
            <div className="sm:hidden absolute -bottom-8 right-0 whitespace-nowrap bg-surface-subtle border border-border-element px-2 py-1 text-[10px] text-ink-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30">
              {prefs.auto_draft ? "Auto-draft ON" : "Auto-draft OFF"}
            </div>
          </label>
        </div>
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

      {/* ── Suggestion Cards — pinned above composer ── */}
      {suggestions.length > 0 && (
        <div className="shrink-0 max-h-[35%] overflow-y-auto border-t border-border-grid bg-surface-card p-3 space-y-3">
          {suggestions.map((s) => (
            <Card key={s.id} className="border-primary/30 bg-accent">
              <CardContent className="py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot className="h-3.5 w-3.5 text-primary" strokeWidth={1.5} />
                    <span className="text-label text-primary">AI Suggested Response</span>
                  </div>
                  <button
                    onClick={() => handleGenerate()}
                    disabled={generating}
                    className="flex items-center gap-1 text-[10px] text-ink-tertiary hover:text-primary transition-colors"
                    title="Regenerate response"
                  >
                    <RefreshCw className={cn("h-3 w-3", generating && "animate-spin")} strokeWidth={1.5} />
                    Regenerate
                  </button>
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

      {/* ── Composer Bar — always visible at bottom ── */}
      <div className="shrink-0 border-t border-border-grid bg-surface-card">
        {/* Tone Presets */}
        <div className="flex items-center gap-1 px-3 pt-2 pb-1 overflow-x-auto scrollbar-hide">
          {TONE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => handleTonePreset(preset.instruction)}
              disabled={generating}
              className={cn(
                "flex items-center gap-1 shrink-0 px-2 py-1 text-[10px] uppercase tracking-wider",
                "border border-border-element text-ink-tertiary",
                "hover:border-primary/40 hover:text-primary hover:bg-primary/5",
                "transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <preset.icon className="h-3 w-3" strokeWidth={1.5} />
              {preset.label}
            </button>
          ))}
        </div>

        {/* Instruction Input */}
        <div className="px-3 pb-2 pt-1">
          <div className="flex gap-1.5 items-end">
            <div className="flex-1 relative">
              {composerExpanded ? (
                <Textarea
                  ref={instructionRef}
                  placeholder="Guide the AI — e.g. 'mention the project deadline' or 'ask about their weekend'..."
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  disabled={generating}
                  rows={2}
                  className="text-xs resize-none pr-8"
                />
              ) : (
                <button
                  onClick={() => setComposerExpanded(true)}
                  className="w-full text-left px-3 py-2 text-xs text-ink-tertiary border border-border-element hover:border-ink-tertiary/30 transition-colors"
                >
                  Guide the AI response... <span className="text-ink-tertiary/50">(optional)</span>
                </button>
              )}
              {composerExpanded && instruction && (
                <button
                  onClick={() => {
                    setInstruction("");
                    setComposerExpanded(false);
                  }}
                  className="absolute right-2 top-2 text-ink-tertiary hover:text-ink-primary transition-colors"
                >
                  <X className="h-3 w-3" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <Button
              onClick={() => handleGenerate()}
              disabled={generating}
              size="sm"
              className="h-9 w-9 p-0 shrink-0"
              title={instruction.trim() ? "Generate with instructions" : "Generate response"}
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={2} />
              )}
            </Button>
          </div>
          {composerExpanded && (
            <p className="mt-1 text-[10px] text-ink-tertiary">
              Enter to generate · Shift+Enter for newline · Esc to collapse
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
