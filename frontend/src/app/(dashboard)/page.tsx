"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useWebSocket } from "@/hooks/use-websocket";
import type {
  DashboardOverview,
  CriticalActionsResponse,
  ActivitySummaryResponse,
  ScopeOption,
  TelegramFolder,
  CostSummary,
  WSEvent,
} from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Users,
  MessageSquare,
  FileText,
  Database,
  AlertTriangle,
  Sparkles,
  Wifi,
  WifiOff,
  DollarSign,
  ArrowUpRight,
  Bot,
  FileDown,
  Send,
  Pencil,
  X,
  Loader2,
  RefreshCw,
  Clock,
  Filter,
  ChevronDown,
  Zap,
  Flame,
  CircleDot,
  BookOpen,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

// ── Urgency helpers ──

const urgencyConfig = {
  critical: {
    icon: Flame,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
  },
  high: {
    icon: Zap,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
  medium: {
    icon: CircleDot,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
} as const;

function formatWaiting(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Scope Selector ──

function ScopeSelector({
  currentScope,
  onScopeChange,
}: {
  currentScope: string;
  onScopeChange: (type: string, ids?: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const { data: options } = useQuery({
    queryKey: ["dashboard-scope-options"],
    queryFn: () =>
      api.dashboard.scopeOptions() as Promise<{ contacts: ScopeOption[] }>,
    staleTime: 60000,
  });

  const { data: telegramFolders } = useQuery({
    queryKey: ["telegram-folders-dashboard"],
    queryFn: () =>
      api.chat.folders() as Promise<{ folders: TelegramFolder[] }>,
    staleTime: 60_000,
  });

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const presets = [
    { type: "all", label: "All Chats" },
    { type: "dms", label: "DMs Only" },
    { type: "groups", label: "Groups Only" },
  ];

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(!open);
          setShowCustom(false);
        }}
        className="gap-1.5"
      >
        <Filter className="h-3.5 w-3.5" strokeWidth={1.5} />
        {currentScope}
        <ChevronDown className="h-3 w-3 opacity-50" strokeWidth={1.5} />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 border border-border-element bg-card shadow-lg">
          <div className="p-1">
            {presets.map((p) => (
              <button
                key={p.type}
                className="flex w-full items-center px-3 py-2 text-sm text-ink-secondary hover:bg-accent hover:text-ink-primary transition-colors"
                onClick={() => {
                  onScopeChange(p.type);
                  setOpen(false);
                }}
              >
                {p.label}
              </button>
            ))}
            <button
              className="flex w-full items-center px-3 py-2 text-sm text-ink-secondary hover:bg-accent hover:text-ink-primary transition-colors"
              onClick={() => setShowCustom(!showCustom)}
            >
              Watched Chats...
            </button>
          </div>

          {!!telegramFolders?.folders?.length && (
            <div className="border-t border-border-element p-1">
              <p className="px-3 py-1 text-[10px] text-ink-tertiary uppercase tracking-wider">
                Telegram Folders
              </p>
              {telegramFolders.folders.map((f) => (
                <button
                  key={f.folder_id}
                  className="flex w-full items-center px-3 py-2 text-sm text-ink-secondary hover:bg-accent hover:text-ink-primary transition-colors"
                  onClick={() => {
                    onScopeChange("custom", f.contact_ids);
                    setOpen(false);
                    setShowCustom(false);
                  }}
                >
                  <span className="truncate">
                    {f.emoticon ? `${f.emoticon} ` : ""}
                    {f.title}
                  </span>
                  <span className="ml-auto text-[10px] text-ink-tertiary">
                    {f.chat_count}
                  </span>
                </button>
              ))}
            </div>
          )}

          {showCustom && options?.contacts && (
            <div className="border-t border-border-element">
              <div className="max-h-48 overflow-y-auto p-1">
                {options.contacts.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink-secondary hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(c.id)}
                      onChange={(e) => {
                        setSelectedIds((prev) =>
                          e.target.checked
                            ? [...prev, c.id]
                            : prev.filter((id) => id !== c.id)
                        );
                      }}
                      className="accent-primary"
                    />
                    <span className="truncate">{c.label}</span>
                    <span className="ml-auto text-[10px] text-ink-tertiary">
                      {c.chat_type === "personal_chat"
                        ? "DM"
                        : c.chat_type === "group" || c.chat_type === "supergroup"
                          ? "Group"
                          : "Channel"}
                    </span>
                  </label>
                ))}
              </div>
              <div className="border-t border-border-element p-2">
                <Button
                  size="sm"
                  className="w-full"
                  disabled={selectedIds.length === 0}
                  onClick={() => {
                    onScopeChange("custom", selectedIds);
                    setOpen(false);
                    setShowCustom(false);
                  }}
                >
                  Apply ({selectedIds.length} selected)
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──

export default function OverviewPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Invalidate dashboard queries on real-time events
  const handleWsEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "sync_complete") {
        queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
        queryClient.invalidateQueries({ queryKey: ["contacts"] });
        toast.success(event.message || "Telegram sync complete");
        return;
      }
      if (
        event.type === "new_message" ||
        event.type === "suggestion_ready"
      ) {
        queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      }
    },
    [queryClient]
  );

  useWebSocket(handleWsEvent);

  // ── Data fetching ──

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: () => api.dashboard.overview() as Promise<DashboardOverview>,
    refetchInterval: 10000,
  });

  const { data: costs } = useQuery({
    queryKey: ["dashboard-costs"],
    queryFn: () => api.dashboard.costs() as Promise<CostSummary>,
    refetchInterval: 30000,
  });

  const {
    data: critical,
    isLoading: criticalLoading,
  } = useQuery({
    queryKey: ["dashboard-critical"],
    queryFn: () =>
      api.dashboard.criticalActions() as Promise<CriticalActionsResponse>,
    refetchInterval: 15000,
  });

  const {
    data: briefing,
    isLoading: briefingLoading,
    refetch: refetchBriefing,
  } = useQuery({
    queryKey: ["dashboard-briefing"],
    queryFn: () =>
      api.dashboard.activitySummary() as Promise<ActivitySummaryResponse>,
    refetchInterval: false, // Don't auto-refresh the AI summary
    staleTime: 300000, // 5 min
  });

  // Mark visited on mount (fire-and-forget)
  useEffect(() => {
    api.dashboard.markVisited().catch(() => {});
  }, []);

  // ── Scope mutation ──

  const scopeMutation = useMutation({
    mutationFn: ({
      type,
      ids,
    }: {
      type: string;
      ids?: string[];
    }) => api.dashboard.updateScope(type, ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-briefing"] });
      toast.success("Dashboard scope updated");
    },
  });

  const handleScopeChange = (type: string, ids?: string[]) => {
    scopeMutation.mutate({ type, ids });
  };

  // ── Regenerate briefing mutation ──

  const regenerateBriefingMutation = useMutation({
    mutationFn: () =>
      api.dashboard.activitySummary(true) as Promise<ActivitySummaryResponse>,
    onSuccess: (data) => {
      queryClient.setQueryData(["dashboard-briefing"], data);
      toast.success("Briefing regenerated");
    },
    onError: () => {
      toast.error("Failed to regenerate briefing");
    },
  });

  // ── Suggestion actions ──

  const handleRespondAll = async () => {
    try {
      toast.info("Generating responses for all unresponded contacts...");
      await api.suggestions.generateAll();
      toast.success("Responses generated! Check your inbox.");
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
    } catch {
      toast.error("Failed to generate responses");
    }
  };

  const handleDraft = async (suggestionId: string, contactName: string) => {
    try {
      await api.suggestions.approve(suggestionId, "draft");
      toast.success(
        `Draft saved for ${contactName} — open Telegram to review & send`
      );
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to save draft");
    }
  };

  const handleSendNow = async (suggestionId: string, contactName: string) => {
    try {
      await api.suggestions.approve(suggestionId, "send");
      toast.success(`Message sent to ${contactName}`);
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to send");
    }
  };

  const handleEditSubmit = async (
    suggestionId: string,
    mode: "draft" | "send"
  ) => {
    try {
      await api.suggestions.edit(suggestionId, editText, mode);
      setEditingId(null);
      const action = mode === "draft" ? "Draft saved" : "Message sent";
      toast.success(action);
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleReject = async (suggestionId: string) => {
    try {
      await api.suggestions.reject(suggestionId);
      queryClient.invalidateQueries({ queryKey: ["dashboard-critical"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to reject");
    }
  };

  const stats = [
    { label: "Contacts", value: overview?.total_contacts ?? 0, icon: Users },
    {
      label: "Messages",
      value: overview?.total_messages ?? 0,
      icon: MessageSquare,
    },
    {
      label: "Documents",
      value: overview?.total_documents ?? 0,
      icon: FileText,
    },
    {
      label: "Indexed Chunks",
      value: overview?.total_chunks ?? 0,
      icon: Database,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-h1 text-ink-primary">Dashboard</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Overview of your James Bot assistant
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScopeSelector
            currentScope={critical?.scope ?? briefing?.scope ?? "All Chats"}
            onScopeChange={handleScopeChange}
          />
          <Button variant="outline" asChild>
            <Link href="/ingest">Upload Chat Export</Link>
          </Button>
          {(overview?.unresponded_count ?? 0) > 0 && (
            <Button onClick={handleRespondAll}>
              <Sparkles className="mr-2 h-4 w-4" strokeWidth={1.5} />
              Respond to All ({overview?.unresponded_count})
            </Button>
          )}
        </div>
      </div>

      {/* Telegram Status */}
      <Card>
        <CardContent className="flex items-center gap-3 py-3">
          {overview?.telegram_connected ? (
            <>
              <Wifi
                className="h-4 w-4 text-signal-success"
                strokeWidth={1.5}
              />
              <span className="text-sm text-signal-success">
                Telegram Connected
              </span>
              <span className="text-sm text-ink-tertiary">
                — Live monitoring active
              </span>
            </>
          ) : (
            <>
              <WifiOff
                className="h-4 w-4 text-signal-warning"
                strokeWidth={1.5}
              />
              <span className="text-sm text-signal-warning">
                Telegram Not Connected
              </span>
              <Button variant="link" size="sm" asChild>
                <Link href="/settings">Connect in Settings</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stats Cards — Bento Grid */}
      <div className="grid grid-cols-2 gap-px bg-border-grid lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="border-0">
            <CardContent className="flex items-center gap-4 py-5">
              <div className="flex h-9 w-9 items-center justify-center bg-accent">
                <stat.icon
                  className="h-4 w-4 text-primary"
                  strokeWidth={1.5}
                />
              </div>
              <div>
                {overviewLoading ? (
                  <Skeleton className="h-7 w-16" />
                ) : (
                  <p className="text-2xl font-light text-ink-primary font-mono tabular-nums">
                    {stat.value.toLocaleString()}
                  </p>
                )}
                <p className="text-label text-ink-tertiary mt-0.5">
                  {stat.label}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Main Cards: Critical Actions + Activity Briefing ── */}
      <div className="grid gap-px bg-border-grid lg:grid-cols-2">
        {/* Critical Actions */}
        <Card className="border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle
                className="h-4 w-4 text-signal-warning"
                strokeWidth={1.5}
              />
              Needs Attention ({critical?.total ?? 0})
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox?sort=unresponded">
                View All
                <ArrowUpRight
                  className="ml-1 h-3 w-3 text-primary"
                  strokeWidth={1.5}
                />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {criticalLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))
            ) : (critical?.actions ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-tertiary">
                All caught up — nothing needs your attention.
              </p>
            ) : (
              (critical?.actions ?? []).slice(0, 8).map((action) => {
                const config = urgencyConfig[action.urgency];
                const UrgencyIcon = config.icon;

                return (
                  <div
                    key={action.contact_id}
                    className={`border p-3 transition-colors ${config.border}`}
                  >
                    {/* Contact row */}
                    <div
                      className="flex cursor-pointer items-start justify-between gap-2"
                      onClick={() =>
                        router.push(`/inbox/${action.contact_id}`)
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <UrgencyIcon
                            className={`h-3.5 w-3.5 shrink-0 ${config.color}`}
                            strokeWidth={1.5}
                          />
                          <p className="truncate text-sm text-ink-primary">
                            {action.display_name}
                          </p>
                          {action.chat_type !== "personal_chat" && (
                            <span className="text-[10px] text-ink-tertiary px-1 border border-border-element">
                              {action.chat_type === "group" ||
                              action.chat_type === "supergroup"
                                ? "Group"
                                : "Channel"}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-tertiary pl-5.5">
                          {action.last_message_preview || "No preview"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {action.hours_waiting >= 1 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-ink-tertiary">
                            <Clock className="h-2.5 w-2.5" strokeWidth={1.5} />
                            {formatWaiting(action.hours_waiting)}
                          </span>
                        )}
                        <Badge
                          variant="secondary"
                          className={`text-[10px] px-1.5 py-0 border ${config.badge}`}
                        >
                          {action.unresponded_count}
                        </Badge>
                      </div>
                    </div>

                    {/* Reason tag */}
                    <p className="mt-1 text-[10px] text-ink-tertiary pl-5.5">
                      {action.reason}
                    </p>

                    {/* Inline suggestion */}
                    {action.pending_suggestion_id &&
                      action.pending_suggestion_text && (
                        <div className="mt-2 border-t border-border-element pt-2">
                          <div className="mb-1.5 flex items-center gap-1.5">
                            <Bot
                              className="h-3 w-3 text-primary"
                              strokeWidth={1.5}
                            />
                            <span className="text-[11px] text-primary">
                              Suggested Response
                            </span>
                          </div>

                          {editingId === action.pending_suggestion_id ? (
                            <div className="space-y-2">
                              <Textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={3}
                                className="text-xs"
                              />
                              <div className="flex flex-wrap gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    handleEditSubmit(
                                      action.pending_suggestion_id!,
                                      "draft"
                                    )
                                  }
                                >
                                  <FileDown
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                  Save as Draft
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    handleEditSubmit(
                                      action.pending_suggestion_id!,
                                      "send"
                                    )
                                  }
                                >
                                  <Send
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                  Send Now
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
                              <p className="text-xs text-ink-secondary whitespace-pre-wrap line-clamp-3">
                                {action.pending_suggestion_text}
                              </p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDraft(
                                      action.pending_suggestion_id!,
                                      action.display_name
                                    );
                                  }}
                                >
                                  <FileDown
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                  Save as Draft
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSendNow(
                                      action.pending_suggestion_id!,
                                      action.display_name
                                    );
                                  }}
                                >
                                  <Send
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                  Send Now
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditText(
                                      action.pending_suggestion_text!
                                    );
                                    setEditingId(
                                      action.pending_suggestion_id!
                                    );
                                  }}
                                >
                                  <Pencil
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleReject(
                                      action.pending_suggestion_id!
                                    );
                                  }}
                                >
                                  <X
                                    className="mr-1 h-3 w-3"
                                    strokeWidth={1.5}
                                  />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      )}

                    {/* Generating indicator */}
                    {!action.pending_suggestion_id &&
                      action.unresponded_count > 0 && (
                        <div className="mt-2 flex items-center gap-1.5 border-t border-border-element pt-2">
                          <Loader2
                            className="h-3 w-3 animate-spin text-ink-tertiary"
                            strokeWidth={1.5}
                          />
                          <span className="text-[11px] text-ink-tertiary">
                            Generating suggestion...
                          </span>
                        </div>
                      )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Activity Briefing */}
        <Card className="border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BookOpen
                className="h-4 w-4 text-primary"
                strokeWidth={1.5}
              />
              Activity Briefing
            </CardTitle>
            <div className="flex items-center gap-1">
              {briefing && (
                <span className="text-[10px] text-ink-tertiary mr-1">
                  {briefing.contacts_active} chats · {briefing.messages_count}{" "}
                  msgs
                  {briefing.cached && " · cached"}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchBriefing()}
                disabled={briefingLoading}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${briefingLoading ? "animate-spin" : ""}`}
                  strokeWidth={1.5}
                />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {briefingLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : briefing?.summary ? (
              <div className="space-y-4">
                {/* Since timestamp */}
                <p className="text-[10px] text-ink-tertiary flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" strokeWidth={1.5} />
                  Since{" "}
                  {new Date(briefing.since).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {briefing.scope}
                </p>

                {/* Rendered summary */}
                <div className="prose-sm prose-invert max-w-none">
                  <BriefingMarkdown content={briefing.summary} />
                </div>

                {/* Force refresh */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => regenerateBriefingMutation.mutate()}
                  disabled={regenerateBriefingMutation.isPending}
                >
                  <RefreshCw
                    className={`mr-1.5 h-3 w-3 ${regenerateBriefingMutation.isPending ? "animate-spin" : ""}`}
                    strokeWidth={1.5}
                  />
                  {regenerateBriefingMutation.isPending
                    ? "Regenerating..."
                    : "Regenerate Briefing"}
                </Button>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-ink-tertiary">
                No activity to summarize.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost Summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign
              className="h-4 w-4 text-signal-success"
              strokeWidth={1.5}
            />
            API Costs
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/costs">
              Details
              <ArrowUpRight
                className="ml-1 h-3 w-3 text-primary"
                strokeWidth={1.5}
              />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {costs ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xl font-mono text-ink-primary">
                  {costs.total_cost_usd < 0.01
                    ? `$${costs.total_cost_usd.toFixed(4)}`
                    : `$${costs.total_cost_usd.toFixed(2)}`}
                </p>
                <p className="text-label text-ink-tertiary mt-1">Total</p>
              </div>
              <div>
                <p className="text-xl font-mono text-ink-primary">
                  {costs.today_cost_usd < 0.01
                    ? `$${costs.today_cost_usd.toFixed(4)}`
                    : `$${costs.today_cost_usd.toFixed(2)}`}
                </p>
                <p className="text-label text-ink-tertiary mt-1">Today</p>
              </div>
              <div>
                <p className="text-xl font-mono text-ink-primary">
                  {costs.total_api_calls.toLocaleString()}
                </p>
                <p className="text-label text-ink-tertiary mt-1">API Calls</p>
              </div>
            </div>
          ) : (
            <Skeleton className="h-14 w-full" />
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link href="/ingest">Upload Chat Export</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/knowledge">Upload Document</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/ingest">Query Chat History</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/settings">Telegram Settings</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Briefing Markdown Renderer ──
// Simple renderer for the structured AI summary output

function BriefingMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    // H2 headings
    if (trimmed.startsWith("## ")) {
      elements.push(
        <h3
          key={i}
          className="text-xs font-semibold text-ink-primary mt-3 first:mt-0 mb-1.5 flex items-center gap-1.5"
        >
          {trimmed.slice(3)}
        </h3>
      );
      continue;
    }

    // Bullet points
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const text = trimmed.slice(2);
      elements.push(
        <p key={i} className="text-xs text-ink-secondary pl-3 py-0.5 border-l border-border-element">
          <InlineMarkdown text={text} />
        </p>
      );
      continue;
    }

    // Regular text
    elements.push(
      <p key={i} className="text-xs text-ink-secondary">
        <InlineMarkdown text={trimmed} />
      </p>
    );
  }

  return <div className="space-y-0.5">{elements}</div>;
}

function InlineMarkdown({ text }: { text: string }) {
  // Bold **text** and `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <span key={i} className="font-medium text-ink-primary">
              {part.slice(2, -2)}
            </span>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="px-1 py-0.5 bg-accent text-ink-primary text-[11px] font-mono"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
