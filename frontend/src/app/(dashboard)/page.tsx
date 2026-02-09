"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useWebSocket } from "@/hooks/use-websocket";
import type {
  DashboardOverview,
  UnrespondedContact,
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
  AlertCircle,
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
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function OverviewPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Invalidate dashboard queries on real-time events
  const handleWsEvent = useCallback(
    (event: WSEvent) => {
      if (event.type === "sync_complete") {
        // Full Telegram sync finished — refresh everything
        queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
        queryClient.invalidateQueries({ queryKey: ["contacts"] });
        toast.success(event.message || "Telegram sync complete");
        return;
      }
      if (
        event.type === "new_message" ||
        event.type === "suggestion_ready"
      ) {
        queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
      }
    },
    [queryClient]
  );

  useWebSocket(handleWsEvent);

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

  const { data: unresponded, isLoading: unrespondedLoading } = useQuery({
    queryKey: ["dashboard-unresponded"],
    queryFn: () =>
      api.dashboard.unresponded() as Promise<{
        contacts: UnrespondedContact[];
        total: number;
      }>,
    refetchInterval: 15000,
  });

  const handleRespondAll = async () => {
    try {
      toast.info("Generating responses for all unresponded contacts...");
      await api.suggestions.generateAll();
      toast.success("Responses generated! Check your inbox.");
      queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
    } catch {
      toast.error("Failed to generate responses");
    }
  };

  const handleDraft = async (suggestionId: string, contactName: string) => {
    try {
      await api.suggestions.approve(suggestionId, "draft");
      toast.success(`Draft saved for ${contactName} — open Telegram to review & send`);
      queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to save draft");
    }
  };

  const handleSendNow = async (suggestionId: string, contactName: string) => {
    try {
      await api.suggestions.approve(suggestionId, "send");
      toast.success(`Message sent to ${contactName}`);
      queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
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
      queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleReject = async (suggestionId: string) => {
    try {
      await api.suggestions.reject(suggestionId);
      queryClient.invalidateQueries({ queryKey: ["dashboard-unresponded"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] });
    } catch {
      toast.error("Failed to reject");
    }
  };

  const stats = [
    {
      label: "Contacts",
      value: overview?.total_contacts ?? 0,
      icon: Users,
    },
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
        <div className="flex flex-wrap gap-2">
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
              <Wifi className="h-4 w-4 text-signal-success" strokeWidth={1.5} />
              <span className="text-sm text-signal-success">
                Telegram Connected
              </span>
              <span className="text-sm text-ink-tertiary">
                — Live monitoring active
              </span>
            </>
          ) : (
            <>
              <WifiOff className="h-4 w-4 text-signal-warning" strokeWidth={1.5} />
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
                <stat.icon className="h-4 w-4 text-primary" strokeWidth={1.5} />
              </div>
              <div>
                {overviewLoading ? (
                  <Skeleton className="h-7 w-16" />
                ) : (
                  <p className="text-2xl font-light text-ink-primary font-mono tabular-nums">
                    {stat.value.toLocaleString()}
                  </p>
                )}
                <p className="text-label text-ink-tertiary mt-0.5">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Alert Cards */}
      <div className="grid gap-px bg-border-grid lg:grid-cols-2">
        {/* Unresponded */}
        <Card className="border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-signal-warning" strokeWidth={1.5} />
              Unresponded ({overview?.unresponded_count ?? 0})
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox?sort=unresponded">
                View All
                <ArrowUpRight className="ml-1 h-3 w-3 text-primary" strokeWidth={1.5} />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {unrespondedLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))
            ) : (unresponded?.contacts ?? []).length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-tertiary">
                All caught up!
              </p>
            ) : (
              (unresponded?.contacts ?? []).slice(0, 5).map((c) => (
                <div
                  key={c.contact_id}
                  className="border border-border-element p-3 transition-colors"
                >
                  {/* Contact row */}
                  <div
                    className="flex cursor-pointer items-center justify-between"
                    onClick={() => router.push(`/inbox/${c.contact_id}`)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-primary">
                        {c.display_name}
                      </p>
                      <p className="truncate text-xs text-ink-tertiary">
                        {c.last_message_preview || "No preview"}
                      </p>
                    </div>
                    <Badge variant="secondary">{c.unresponded_count}</Badge>
                  </div>

                  {/* Inline suggestion */}
                  {c.pending_suggestion_id && c.pending_suggestion_text && (
                    <div className="mt-2 border-t border-border-element pt-2">
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <Bot className="h-3 w-3 text-primary" strokeWidth={1.5} />
                        <span className="text-[11px] text-primary">
                          Suggested Response
                        </span>
                      </div>

                      {editingId === c.pending_suggestion_id ? (
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
                                handleEditSubmit(c.pending_suggestion_id!, "draft")
                              }
                            >
                              <FileDown className="mr-1 h-3 w-3" strokeWidth={1.5} />
                              Save as Draft
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                handleEditSubmit(c.pending_suggestion_id!, "send")
                              }
                            >
                              <Send className="mr-1 h-3 w-3" strokeWidth={1.5} />
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
                            {c.pending_suggestion_text}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDraft(
                                  c.pending_suggestion_id!,
                                  c.display_name
                                );
                              }}
                            >
                              <FileDown className="mr-1 h-3 w-3" strokeWidth={1.5} />
                              Save as Draft
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSendNow(
                                  c.pending_suggestion_id!,
                                  c.display_name
                                );
                              }}
                            >
                              <Send className="mr-1 h-3 w-3" strokeWidth={1.5} />
                              Send Now
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditText(c.pending_suggestion_text!);
                                setEditingId(c.pending_suggestion_id!);
                              }}
                            >
                              <Pencil className="mr-1 h-3 w-3" strokeWidth={1.5} />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReject(c.pending_suggestion_id!);
                              }}
                            >
                              <X className="mr-1 h-3 w-3" strokeWidth={1.5} />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Generating indicator: has unresponded but no suggestion yet */}
                  {!c.pending_suggestion_id && c.unresponded_count > 0 && (
                    <div className="mt-2 flex items-center gap-1.5 border-t border-border-element pt-2">
                      <Loader2 className="h-3 w-3 animate-spin text-ink-tertiary" strokeWidth={1.5} />
                      <span className="text-[11px] text-ink-tertiary">
                        Generating suggestion...
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Pending Suggestions */}
        <Card className="border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" strokeWidth={1.5} />
              Pending Suggestions ({overview?.pending_suggestions ?? 0})
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox">
                Review
                <ArrowUpRight className="ml-1 h-3 w-3 text-primary" strokeWidth={1.5} />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {(overview?.pending_suggestions ?? 0) === 0 ? (
              <p className="py-4 text-center text-sm text-ink-tertiary">
                No pending suggestions
              </p>
            ) : (
              <p className="py-4 text-center text-sm text-ink-secondary">
                You have{" "}
                <span className="text-primary font-mono">
                  {overview?.pending_suggestions}
                </span>{" "}
                response{(overview?.pending_suggestions ?? 0) > 1 ? "s" : ""} waiting
                for review in your inbox.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost Summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-signal-success" strokeWidth={1.5} />
            API Costs
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/costs">
              Details
              <ArrowUpRight className="ml-1 h-3 w-3 text-primary" strokeWidth={1.5} />
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
            <Link href="/query">Query Chat History</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/settings">Telegram Settings</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
