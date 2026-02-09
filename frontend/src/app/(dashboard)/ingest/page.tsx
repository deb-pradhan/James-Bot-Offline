"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useWebSocket } from "@/hooks/use-websocket";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Square,
  History,
  Calendar,
  MessageSquare,
  FileJson,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

interface IngestionStep {
  step: string;
  label: string;
  progress?: number;
  total?: number;
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

const STEP_LABELS: Record<string, string> = {
  parsing: "Parsing export file",
  importing: "Importing contacts & messages",
  chunking: "Chunking conversations",
  embedding: "Generating embeddings",
  analyzing: "Analyzing communication styles",
  complete: "Ingestion complete!",
};

export default function IngestPage() {
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "stopping" | "complete" | "error">("idle");
  const [currentStep, setCurrentStep] = useState<IngestionStep | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const { lastEvent } = useWebSocket();
  const checkedRef = useRef(false);
  const lastProcessedEventRef = useRef<string | null>(null);

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
      if (job.status === "processing") {
        setStatus("processing");
        setCurrentStep({
          step: job.step ?? "parsing",
          label: STEP_LABELS[job.step ?? "parsing"] ?? job.message ?? "Processing...",
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

  // Track WebSocket events for progress — in useEffect to avoid setState during render
  useEffect(() => {
    if (!lastEvent) return;

    // Deduplicate: create a fingerprint so we don't process the same event twice
    const fingerprint = JSON.stringify(lastEvent);
    if (fingerprint === lastProcessedEventRef.current) return;
    lastProcessedEventRef.current = fingerprint;

    if (lastEvent.type === "ingestion_progress" && (status === "processing" || status === "stopping")) {
      const data = lastEvent.data as { step?: string; progress?: number; total?: number };
      const step = data?.step ?? "";

      // If step is "complete", transition immediately
      if (step === "complete") {
        setStatus("complete");
        setCurrentStep(null);
        fetchHistory();
        return;
      }

      // Check if the message indicates a stop (backend sends "stopped by user" message)
      const message = lastEvent.message ?? "";
      const isStopped = message.toLowerCase().includes("stopped by user");

      if (isStopped) {
        // Analysis was stopped — we'll get "complete" step momentarily
        setStatus("stopping");
        setCurrentStep({
          step,
          label: "Wrapping up — style analysis stopped",
          progress: data?.progress ?? undefined,
          total: data?.total ?? undefined,
        });
        return;
      }

      setCurrentStep({
        step,
        label: STEP_LABELS[step] ?? message ?? "Processing...",
        progress: data?.progress ?? undefined,
        total: data?.total ?? undefined,
      });
    }

    if (lastEvent.type === "ingestion_complete" && (status === "processing" || status === "stopping")) {
      setStatus("complete");
      setResult(lastEvent.data as Record<string, number>);
      setCurrentStep(null);
      fetchHistory();
    }

    if (lastEvent.type === "error" && (status === "processing" || status === "stopping")) {
      setStatus("error");
      setErrorMessage(lastEvent.message ?? "Ingestion failed");
      setCurrentStep(null);
    }
  }, [lastEvent, status, fetchHistory]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".json")) {
        toast.error("Please upload a .json file");
        return;
      }

      setStatus("uploading");
      try {
        const res = await api.ingest.telegram(file);
        setStatus("processing");
        setCurrentStep({ step: "parsing", label: STEP_LABELS.parsing });
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

  const handleStopAnalysis = useCallback(async () => {
    try {
      await api.ingest.stopAnalysis();
      setStatus("stopping");
      toast.success("Stopping — will halt after the current contact finishes.");
    } catch {
      toast.error("Failed to stop analysis");
    }
  }, []);

  const isAnalyzing = currentStep?.step === "analyzing";
  const isStopping = status === "stopping";
  const isProcessingOrStopping = status === "processing" || status === "stopping";

  const progressPercent =
    currentStep?.progress && currentStep?.total
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
          ) : isProcessingOrStopping ? (
            <div className="space-y-6 py-8">
              <div className="text-center">
                {isStopping ? (
                  <>
                    <Square className="mx-auto mb-4 h-12 w-12 text-signal-warning" strokeWidth={1.5} />
                    <p className="text-sm text-ink-primary">Stopping — finishing current contact...</p>
                  </>
                ) : (
                  <>
                    <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-primary" strokeWidth={1.5} />
                    <p className="text-sm text-ink-primary">Processing your chat history</p>
                  </>
                )}
              </div>

              {/* Current Step */}
              <div className="mx-auto max-w-md space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-primary">
                    {currentStep?.label ?? "Processing..."}
                  </span>
                  {progressPercent !== undefined && (
                    <span className="text-ink-tertiary font-mono text-xs">
                      {progressPercent}%
                    </span>
                  )}
                </div>
                <Progress value={progressPercent ?? 50} />
                {currentStep?.progress && currentStep?.total && (
                  <p className="text-center text-xs text-ink-tertiary font-mono">
                    {currentStep.progress} / {currentStep.total}
                  </p>
                )}
              </div>

              {/* Stop Analysis Button — only when actively analyzing (not already stopping) */}
              {isAnalyzing && !isStopping && (
                <div className="flex justify-center">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleStopAnalysis}
                  >
                    <Square className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                    Stop Style Analysis
                  </Button>
                </div>
              )}

              {/* Step Overview */}
              <div className="mx-auto max-w-xs space-y-2">
                {Object.entries(STEP_LABELS)
                  .filter(([k]) => k !== "complete")
                  .map(([key, label]) => {
                    const stepOrder = ["parsing", "importing", "chunking", "embedding", "analyzing"];
                    const currentIdx = stepOrder.indexOf(currentStep?.step ?? "");
                    const thisIdx = stepOrder.indexOf(key);
                    const isDone = thisIdx < currentIdx || (isStopping && thisIdx <= currentIdx);
                    const isCurrent = key === currentStep?.step && !isStopping;

                    return (
                      <div
                        key={key}
                        className="flex items-center gap-2 text-sm"
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-4 w-4 text-signal-success" strokeWidth={1.5} />
                        ) : isCurrent ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" strokeWidth={1.5} />
                        ) : (
                          <div className="h-4 w-4 border border-border-grid" />
                        )}
                        <span
                          className={
                            isDone
                              ? "text-signal-success"
                              : isCurrent
                                ? "text-ink-primary"
                                : "text-ink-tertiary"
                          }
                        >
                          {key === "analyzing" && isStopping
                            ? "Style analysis stopped"
                            : label}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            /* Complete */
            <div className="flex flex-col items-center py-12">
              <CheckCircle2 className="mb-4 h-16 w-16 text-signal-success" strokeWidth={1.5} />
              <p className="text-sm text-ink-primary">Ingestion Complete!</p>
              {result && (
                <div className="mt-4 flex gap-6 text-center">
                  <div>
                    <p className="text-2xl font-light font-mono text-ink-primary">{result.chats}</p>
                    <p className="text-label text-ink-tertiary mt-1">Chats</p>
                  </div>
                  <div>
                    <p className="text-2xl font-light font-mono text-ink-primary">{result.messages}</p>
                    <p className="text-label text-ink-tertiary mt-1">Messages</p>
                  </div>
                  <div>
                    <p className="text-2xl font-light font-mono text-ink-primary">{result.chunks}</p>
                    <p className="text-label text-ink-tertiary mt-1">Chunks</p>
                  </div>
                </div>
              )}
              <Button
                variant="outline"
                className="mt-6"
                onClick={() => {
                  setStatus("idle");
                  setResult(null);
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
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-primary" strokeWidth={1.5} />
            Ingestion History
          </CardTitle>
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
    </div>
  );
}
