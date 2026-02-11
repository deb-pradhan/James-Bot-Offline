"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWebSocket } from "@/hooks/use-websocket";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Square,
  Pause,
  Play,
  History,
  Calendar,
  MessageSquare,
  FileJson,
  AlertTriangle,
  RotateCcw,
  Users,
  Database,
  Layers,
  Cpu,
  Sparkles,
  Ban,
} from "lucide-react";
import { toast } from "sonner";

interface IngestionStats {
  contacts_processed: number;
  messages_synced: number;
  duplicates_skipped: number;
  chunks_created: number;
  embeddings_generated: number;
  styles_analyzed: number;
}

interface IngestionStep {
  step: string;
  label: string;
  progress?: number;
  total?: number;
  stats?: IngestionStats;
}

interface HistoryItem {
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

type PageStatus = "idle" | "uploading" | "processing" | "paused" | "stopping" | "complete" | "error";

const EMPTY_STATS: IngestionStats = {
  contacts_processed: 0,
  messages_synced: 0,
  duplicates_skipped: 0,
  chunks_created: 0,
  embeddings_generated: 0,
  styles_analyzed: 0,
};

export default function IngestPage() {
  const [status, setStatus] = useState<PageStatus>("idle");
  const [currentStep, setCurrentStep] = useState<IngestionStep | null>(null);
  const [liveStats, setLiveStats] = useState<IngestionStats>(EMPTY_STATS);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { lastEvent } = useWebSocket();
  const checkedRef = useRef(false);
  const lastProcessedEventRef = useRef<string | null>(null);
  const noActiveJobToastRef = useRef(false);
  const isStopping = status === "stopping";
  const isPaused = status === "paused";
  const isActive = status === "processing" || status === "paused" || status === "stopping";

  const fetchHistory = useCallback(async () => {
    try {
      setHistoryLoading(true);
      const data = await api.ingest.history({ limit: 10 });
      setHistory(data.items);
    } catch {
      // Silently ignore
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // On mount: check for active/recent jobs so we survive page refreshes
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    fetchHistory();

    api.ingest.status().then((job) => {
      if (!job) return;
      if (job.status === "processing" || job.status === "paused") {
        setStatus(job.status);
        setCurrentStep({
          step: job.step ?? "parsing",
          label: job.message ?? "Processing...",
          progress: job.progress ?? undefined,
          total: job.total ?? undefined,
        });
      } else if (job.status === "complete") {
        setStatus("complete");
        setResult(job.result ?? null);
      } else if (job.status === "failed") {
        setStatus("error");
        setErrorMessage(job.message ?? "Ingestion failed");
      }
    }).catch(() => {
      // Silently ignore — user just sees idle state
    });
  }, [fetchHistory]);

  // Track WebSocket events for progress
  useEffect(() => {
    if (!lastEvent) return;

    const fingerprint = JSON.stringify(lastEvent);
    if (fingerprint === lastProcessedEventRef.current) return;
    lastProcessedEventRef.current = fingerprint;

    if (lastEvent.type === "ingestion_progress" && isActive) {
      const data = lastEvent.data as {
        step?: string;
        progress?: number;
        total?: number;
        stats?: IngestionStats;
      };
      const step = data?.step ?? "";
      const message = (lastEvent.message as string) ?? "";

      // Update live stats if present
      if (data?.stats) {
        setLiveStats(data.stats);
      }

      // If step is "complete", transition immediately
      if (step === "complete") {
        setStatus("complete");
        setCurrentStep(null);
        fetchHistory();
        return;
      }

      // Paused
      if (message === "Paused") {
        setStatus("paused");
        setCurrentStep({
          step,
          label: "Paused",
          progress: data?.progress ?? undefined,
          total: data?.total ?? undefined,
          stats: data?.stats ?? undefined,
        });
        return;
      }

      // Resumed
      if (message === "Resumed") {
        setStatus("processing");
      }

      // Stopped by user
      const isStopped = message.toLowerCase().includes("stopped by user");
      if (isStopped) {
        setStatus("stopping");
        setCurrentStep({
          step,
          label: "Wrapping up — stopping ingestion",
          progress: data?.progress ?? undefined,
          total: data?.total ?? undefined,
          stats: data?.stats ?? undefined,
        });
        return;
      }

      // Normal progress update — use the descriptive message from backend
      if (status !== "paused") {
        setCurrentStep({
          step,
          label: message || "Processing...",
          progress: data?.progress ?? undefined,
          total: data?.total ?? undefined,
          stats: data?.stats ?? undefined,
        });
      }
    }

    if (lastEvent.type === "ingestion_complete" && isActive) {
      setStatus("complete");
      setResult(lastEvent.data as Record<string, number>);
      setCurrentStep(null);
      fetchHistory();
    }

    if (lastEvent.type === "error" && isActive) {
      setStatus("error");
      setErrorMessage((lastEvent.message as string) ?? "Ingestion failed");
      setCurrentStep(null);
    }
  }, [lastEvent, status, isActive, fetchHistory]);

  // Poll active ingestion status as a fallback when WS events are missed
  useEffect(() => {
    if (!isActive) {
      noActiveJobToastRef.current = false;
      return;
    }

    let cancelled = false;

    const syncActiveJob = async () => {
      try {
        const job = await api.ingest.status();
        if (cancelled) return;

        if (!job) {
          setStatus("idle");
          setCurrentStep(null);
          setLiveStats(EMPTY_STATS);
          if (!noActiveJobToastRef.current) {
            toast.warning("No active ingestion job found. Processing view reset.");
            noActiveJobToastRef.current = true;
          }
          return;
        }

        if (job.status === "processing") {
          noActiveJobToastRef.current = false;
          setStatus((prev) => (prev === "stopping" ? prev : "processing"));
          setCurrentStep({
            step: job.step ?? "parsing",
            label: job.message ?? "Processing...",
            progress: job.progress ?? undefined,
            total: job.total ?? undefined,
          });
          return;
        }

        if (job.status === "paused") {
          noActiveJobToastRef.current = false;
          setStatus("paused");
          setCurrentStep({
            step: job.step ?? "parsing",
            label: "Paused",
            progress: job.progress ?? undefined,
            total: job.total ?? undefined,
          });
          return;
        }

        if (job.status === "complete") {
          noActiveJobToastRef.current = false;
          setStatus("complete");
          setResult(job.result ?? null);
          setCurrentStep(null);
          fetchHistory();
          return;
        }

        if (job.status === "failed") {
          noActiveJobToastRef.current = false;
          setStatus("error");
          setErrorMessage(job.message ?? "Ingestion failed");
          setCurrentStep(null);
        }
      } catch {
        // Keep the current UI state and retry on next interval tick
      }
    };

    void syncActiveJob();
    const interval = setInterval(syncActiveJob, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isActive, fetchHistory]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".json")) {
        toast.error("Please upload a .json file");
        return;
      }

      setStatus("uploading");
      setLiveStats(EMPTY_STATS);
      try {
        const res = await api.ingest.telegram(file);
        setStatus("processing");
        setCurrentStep({ step: "parsing", label: "Parsing Telegram export..." });
        if (res.duplicate_warning) {
          toast.warning(res.duplicate_warning, { duration: 8000 });
        }
        if (res.overlap_warning) {
          toast.warning(res.overlap_warning, { duration: 8000 });
        }
        toast.success("Upload complete — processing started!");
      } catch {
        setStatus("error");
        toast.error("Upload failed");
      }
      e.target.value = "";
    },
    []
  );

  const handlePause = useCallback(async () => {
    try {
      await api.ingest.pause();
      setStatus("paused");
      toast.success("Pausing — will pause after current item finishes.");
    } catch {
      toast.error("Failed to pause ingestion");
    }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await api.ingest.resume();
      setStatus("processing");
      toast.success("Resuming ingestion...");
    } catch {
      toast.error("Failed to resume ingestion");
    }
  }, []);

  const handleStopProcessing = useCallback(async () => {
    try {
      await api.ingest.stop();
      setStatus("stopping");
      toast.success("Stopping ingestion — this can take a few seconds.");
    } catch {
      toast.error("Failed to stop ingestion");
    }
  }, []);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await api.ingest.reset();
      setResetDialogOpen(false);
      setStatus("idle");
      setResult(null);
      setLiveStats(EMPTY_STATS);
      setCurrentStep(null);
      toast.success("All data cleared. You can now re-ingest your chat history.");
      fetchHistory();
    } catch {
      toast.error("Failed to reset data. Make sure no ingestion is running.");
    } finally {
      setResetting(false);
    }
  }, [fetchHistory]);

  const progressPercent =
    currentStep?.progress !== undefined &&
    currentStep?.progress !== null &&
    currentStep?.total !== undefined &&
    currentStep?.total !== null &&
    currentStep.total > 0
      ? Math.round((currentStep.progress / currentStep.total) * 100)
      : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1 text-ink-primary">Ingest Chat History</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Upload your Telegram Desktop JSON export to build the AI&apos;s memory
        </p>
      </div>

      {/* Upload Zone */}
      <Card>
        <CardContent className="py-8">
          {status === "idle" || status === "error" ? (
            <label className="flex cursor-pointer flex-col items-center border-2 border-dashed border-border-grid p-6 sm:p-12 transition-colors hover:border-primary/50 hover:bg-surface-subtle/50">
              <Upload className="mb-4 h-16 w-16 text-ink-tertiary/40" strokeWidth={1.5} />
              <p className="text-sm text-ink-primary">
                Drop your Telegram export here
              </p>
              <p className="mt-1 text-xs text-ink-tertiary">
                JSON file from Telegram Desktop → Settings → Export Telegram
                Data
              </p>
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleFileUpload}
              />
              {status === "error" && (
                <div className="mt-4 flex items-center gap-2 text-signal-error">
                  <AlertCircle className="h-4 w-4" strokeWidth={1.5} />
                  <span className="text-sm">
                    {errorMessage ?? "Upload failed"} — try again
                  </span>
                </div>
              )}
            </label>
          ) : status === "uploading" ? (
            <div className="flex flex-col items-center py-12">
              <Loader2 className="mb-4 h-12 w-12 animate-spin text-primary" strokeWidth={1.5} />
              <p className="text-sm text-ink-primary">Uploading...</p>
            </div>
          ) : isActive ? (
            <div className="space-y-6 py-8">
              {/* Header icon + status */}
              <div className="text-center">
                {isStopping ? (
                  <>
                    <Square className="mx-auto mb-4 h-12 w-12 text-signal-warning" strokeWidth={1.5} />
                    <p className="text-sm text-ink-primary">Stopping — finishing current item...</p>
                  </>
                ) : isPaused ? (
                  <>
                    <Pause className="mx-auto mb-4 h-12 w-12 text-signal-warning" strokeWidth={1.5} />
                    <p className="text-sm text-ink-primary">Ingestion paused</p>
                  </>
                ) : (
                  <>
                    <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-primary" strokeWidth={1.5} />
                    <p className="text-sm text-ink-primary">Processing your chat history</p>
                  </>
                )}
              </div>

              {/* Current activity label + progress bar */}
              <div className="mx-auto max-w-md space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-primary truncate">
                    {currentStep?.label ?? "Processing..."}
                  </span>
                  {progressPercent !== undefined && (
                    <span className="text-ink-tertiary font-mono text-xs ml-2 shrink-0">
                      {progressPercent}%
                    </span>
                  )}
                </div>
                <Progress value={progressPercent ?? (isPaused ? progressPercent ?? 0 : 50)} />
              </div>

              {/* Controls: Pause/Resume + Stop */}
              {!isStopping && (
                <div className="flex justify-center gap-3">
                  {isPaused ? (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleResume}
                    >
                      <Play className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePause}
                    >
                      <Pause className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                      Pause
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleStopProcessing}
                  >
                    <Square className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                    Stop
                  </Button>
                </div>
              )}

              {/* Live Stats Grid */}
              <StatsGrid stats={liveStats} dimUnreached={true} currentStep={currentStep?.step} />
            </div>
          ) : (
            /* Complete */
            <div className="flex flex-col items-center py-12">
              <CheckCircle2 className="mb-4 h-16 w-16 text-signal-success" strokeWidth={1.5} />
              <p className="text-sm text-ink-primary">
                {result?.stopped ? "Ingestion Stopped" : "Ingestion Complete!"}
              </p>

              {result && (
                <div className="mt-6 w-full max-w-md">
                  <StatsGrid
                    stats={{
                      contacts_processed: result.contacts ?? result.chats ?? 0,
                      messages_synced: result.messages ?? 0,
                      duplicates_skipped: result.messages_skipped ?? 0,
                      chunks_created: result.chunks ?? 0,
                      embeddings_generated: result.embeddings ?? result.chunks ?? 0,
                      styles_analyzed: result.styles_analyzed ?? 0,
                    }}
                    dimUnreached={false}
                  />
                </div>
              )}

              <Button
                variant="outline"
                className="mt-6"
                onClick={() => {
                  setStatus("idle");
                  setResult(null);
                  setLiveStats(EMPTY_STATS);
                }}
              >
                Upload Another
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ingestion History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 text-primary" strokeWidth={1.5} />
              Ingestion History
            </CardTitle>
            {history.length > 0 && !isActive && (
              <Button
                variant="outline"
                size="sm"
                className="text-signal-error hover:text-signal-error hover:bg-signal-error/10"
                onClick={() => setResetDialogOpen(true)}
              >
                <RotateCcw className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                Reset &amp; Re-ingest
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {historyLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-ink-tertiary" strokeWidth={1.5} />
            </div>
          ) : history.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-tertiary">
              No previous ingestions yet. Upload your first export above.
            </p>
          ) : (
            <div className="space-y-px">
              {history.map((item) => (
                <div
                  key={item.job_id}
                  className="flex flex-col gap-2 border border-border-element p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileJson className="h-4 w-4 text-ink-tertiary" strokeWidth={1.5} />
                      <span className="text-sm text-ink-primary">
                        {item.filename ?? "Unknown file"}
                      </span>
                    </div>
                    <Badge
                      variant={
                        item.status === "complete" ? "default" : "destructive"
                      }
                      className="text-[10px]"
                    >
                      {item.status}
                    </Badge>
                  </div>

                    <div className="flex flex-wrap gap-x-4 sm:gap-x-6 gap-y-1 text-xs text-ink-tertiary">
                    {/* Ingested At */}
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3" strokeWidth={1.5} />
                      Ingested:{" "}
                      {new Date(item.ingested_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>

                    {/* Chat Date Range */}
                    {item.chat_date_start && item.chat_date_end && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" strokeWidth={1.5} />
                        Chats:{" "}
                        {new Date(item.chat_date_start).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric", year: "numeric" }
                        )}{" "}
                        →{" "}
                        {new Date(item.chat_date_end).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric", year: "numeric" }
                        )}
                      </span>
                    )}
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-tertiary font-mono">
                    {item.total_chats != null && (
                      <span>{item.total_chats} chats</span>
                    )}
                    {item.total_messages_in_file != null && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" strokeWidth={1.5} />
                        {item.total_messages_in_file.toLocaleString()} messages
                        in file
                      </span>
                    )}
                    {item.messages_new != null && (
                      <span className="text-signal-success">
                        +{item.messages_new.toLocaleString()} new
                      </span>
                    )}
                    {item.messages_skipped != null &&
                      item.messages_skipped > 0 && (
                        <span className="flex items-center gap-1 text-signal-warning">
                          <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
                          {item.messages_skipped.toLocaleString()} duplicates
                          skipped
                        </span>
                      )}
                    {item.total_chunks != null && (
                      <span>{item.total_chunks} chunks</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Instructions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How to export from Telegram</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-ink-secondary">
          <p>1. Open Telegram Desktop</p>
          <p>
            2. Go to <span className="text-ink-primary">Settings → Advanced → Export Telegram Data</span>
          </p>
          <p>
            3. Select <span className="text-ink-primary">JSON</span> format (uncheck media to keep it small)
          </p>
          <p>4. Choose which chats to include and click Export</p>
          <p>5. Upload the resulting <code className="font-mono text-primary text-xs">result.json</code> file here</p>
        </CardContent>
      </Card>

      {/* Reset Confirmation Dialog */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-signal-error" strokeWidth={1.5} />
              Reset All Ingested Data
            </DialogTitle>
            <DialogDescription className="text-left space-y-2 pt-2">
              <span className="block">
                This will permanently delete <strong>all</strong> your ingested data:
              </span>
              <span className="block text-xs text-ink-tertiary space-y-1">
                <span className="block">• All contacts and their messages</span>
                <span className="block">• All conversation chunks and embeddings</span>
                <span className="block">• All style profiles and suggestions</span>
              </span>
              <span className="block pt-1">
                You&apos;ll need to re-upload your Telegram export to rebuild everything from scratch.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetDialogOpen(false)}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" strokeWidth={1.5} />
              )}
              {resetting ? "Deleting..." : "Delete & Reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Live Stats Grid Component ─── */

const STAT_CONFIG = [
  { key: "contacts_processed" as const, label: "Contacts", icon: Users, reachStep: "importing" },
  { key: "messages_synced" as const, label: "Messages", icon: MessageSquare, reachStep: "importing" },
  { key: "duplicates_skipped" as const, label: "Duplicates Skipped", icon: Ban, reachStep: "importing", warnIfPositive: true },
  { key: "chunks_created" as const, label: "Chunks", icon: Layers, reachStep: "chunking" },
  { key: "embeddings_generated" as const, label: "Embeddings", icon: Cpu, reachStep: "embedding" },
  { key: "styles_analyzed" as const, label: "Styles", icon: Sparkles, reachStep: "analyzing" },
];

const STEP_ORDER = ["parsing", "importing", "chunking", "embedding", "analyzing", "complete"];

function StatsGrid({
  stats,
  dimUnreached = false,
  currentStep,
}: {
  stats: IngestionStats;
  dimUnreached?: boolean;
  currentStep?: string;
}) {
  const currentIdx = currentStep ? STEP_ORDER.indexOf(currentStep) : STEP_ORDER.length;

  return (
    <div className="grid grid-cols-3 gap-3 mx-auto max-w-md">
      {STAT_CONFIG.map(({ key, label, icon: Icon, reachStep, warnIfPositive }) => {
        const stepIdx = STEP_ORDER.indexOf(reachStep);
        const reached = !dimUnreached || currentIdx >= stepIdx;
        const value = stats[key];
        const isWarn = warnIfPositive && value > 0;

        // Hide "Duplicates Skipped" if 0
        if (key === "duplicates_skipped" && value === 0 && dimUnreached) {
          return (
            <div key={key} className="flex flex-col items-center gap-1 rounded-lg border border-border-grid p-3 opacity-30">
              <Icon className="h-4 w-4 text-ink-tertiary" strokeWidth={1.5} />
              <span className="text-[10px] text-ink-tertiary">{label}</span>
              <span className="text-lg font-light font-mono text-ink-tertiary">--</span>
            </div>
          );
        }

        return (
          <div
            key={key}
            className={`flex flex-col items-center gap-1 rounded-lg border p-3 transition-opacity ${
              reached
                ? isWarn
                  ? "border-signal-warning/30 bg-signal-warning/5"
                  : "border-border-grid"
                : "border-border-grid opacity-30"
            }`}
          >
            <Icon
              className={`h-4 w-4 ${
                isWarn ? "text-signal-warning" : reached ? "text-ink-secondary" : "text-ink-tertiary"
              }`}
              strokeWidth={1.5}
            />
            <span className={`text-[10px] ${isWarn ? "text-signal-warning" : "text-ink-tertiary"}`}>
              {label}
            </span>
            <span
              className={`text-lg font-light font-mono ${
                reached
                  ? isWarn
                    ? "text-signal-warning"
                    : "text-ink-primary"
                  : "text-ink-tertiary"
              }`}
            >
              {reached ? value.toLocaleString() : "--"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
