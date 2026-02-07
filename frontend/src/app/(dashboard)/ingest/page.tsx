"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWebSocket } from "@/hooks/use-websocket";
import { Upload, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface IngestionStep {
  step: string;
  label: string;
  progress?: number;
  total?: number;
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
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "complete" | "error">("idle");
  const [currentStep, setCurrentStep] = useState<IngestionStep | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const { lastEvent } = useWebSocket();

  // Track WebSocket events for progress
  if (lastEvent?.type === "ingestion_progress" && status === "processing") {
    const data = lastEvent.data as { step?: string; progress?: number; total?: number };
    const newStep = {
      step: data?.step ?? "",
      label: STEP_LABELS[data?.step ?? ""] ?? lastEvent.message ?? "Processing...",
      progress: data?.progress ?? undefined,
      total: data?.total ?? undefined,
    };
    if (newStep.step !== currentStep?.step || newStep.progress !== currentStep?.progress) {
      setCurrentStep(newStep);
    }
  }

  if (lastEvent?.type === "ingestion_complete" && status === "processing") {
    setStatus("complete");
    setResult(lastEvent.data as Record<string, number>);
    setCurrentStep(null);
  }

  if (lastEvent?.type === "error" && status === "processing") {
    setStatus("error");
    setCurrentStep(null);
  }

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
        await api.ingest.telegram(file);
        setStatus("processing");
        setCurrentStep({ step: "parsing", label: STEP_LABELS.parsing });
        toast.success("Upload complete — processing started!");
      } catch {
        setStatus("error");
        toast.error("Upload failed");
      }
      e.target.value = "";
    },
    []
  );

  const progressPercent =
    currentStep?.progress && currentStep?.total
      ? Math.round((currentStep.progress / currentStep.total) * 100)
      : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ingest Chat History</h1>
        <p className="text-muted-foreground">
          Upload your Telegram Desktop JSON export to build the AI&apos;s memory
        </p>
      </div>

      {/* Upload Zone */}
      <Card>
        <CardContent className="py-8">
          {status === "idle" || status === "error" ? (
            <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed p-12 transition-colors hover:border-primary/50 hover:bg-muted/30">
              <Upload className="mb-4 h-16 w-16 text-muted-foreground/40" />
              <p className="text-lg font-medium">
                Drop your Telegram export here
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
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
                <div className="mt-4 flex items-center gap-2 text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-sm">
                    Upload failed — try again
                  </span>
                </div>
              )}
            </label>
          ) : status === "uploading" ? (
            <div className="flex flex-col items-center py-12">
              <Loader2 className="mb-4 h-12 w-12 animate-spin text-primary" />
              <p className="text-lg font-medium">Uploading...</p>
            </div>
          ) : status === "processing" ? (
            <div className="space-y-6 py-8">
              <div className="text-center">
                <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-primary" />
                <p className="text-lg font-medium">Processing your chat history</p>
              </div>

              {/* Current Step */}
              <div className="mx-auto max-w-md space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {currentStep?.label ?? "Processing..."}
                  </span>
                  {progressPercent !== undefined && (
                    <span className="text-muted-foreground">
                      {progressPercent}%
                    </span>
                  )}
                </div>
                <Progress value={progressPercent ?? 50} />
                {currentStep?.progress && currentStep?.total && (
                  <p className="text-center text-xs text-muted-foreground">
                    {currentStep.progress} / {currentStep.total}
                  </p>
                )}
              </div>

              {/* Step Overview */}
              <div className="mx-auto max-w-xs space-y-2">
                {Object.entries(STEP_LABELS)
                  .filter(([k]) => k !== "complete")
                  .map(([key, label]) => {
                    const stepOrder = ["parsing", "importing", "chunking", "embedding", "analyzing"];
                    const currentIdx = stepOrder.indexOf(currentStep?.step ?? "");
                    const thisIdx = stepOrder.indexOf(key);
                    const isDone = thisIdx < currentIdx;
                    const isCurrent = key === currentStep?.step;

                    return (
                      <div
                        key={key}
                        className="flex items-center gap-2 text-sm"
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : isCurrent ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        ) : (
                          <div className="h-4 w-4 rounded-full border" />
                        )}
                        <span
                          className={
                            isDone
                              ? "text-green-600 dark:text-green-400"
                              : isCurrent
                                ? "font-medium"
                                : "text-muted-foreground"
                          }
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            /* Complete */
            <div className="flex flex-col items-center py-12">
              <CheckCircle2 className="mb-4 h-16 w-16 text-green-500" />
              <p className="text-lg font-medium">Ingestion Complete!</p>
              {result && (
                <div className="mt-4 flex gap-6 text-center">
                  <div>
                    <p className="text-2xl font-bold">{result.chats}</p>
                    <p className="text-xs text-muted-foreground">Chats</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{result.messages}</p>
                    <p className="text-xs text-muted-foreground">Messages</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{result.chunks}</p>
                    <p className="text-xs text-muted-foreground">Chunks</p>
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

      {/* Instructions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to export from Telegram</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>1. Open Telegram Desktop</p>
          <p>
            2. Go to <strong>Settings → Advanced → Export Telegram Data</strong>
          </p>
          <p>
            3. Select <strong>JSON</strong> format (uncheck media to keep it small)
          </p>
          <p>4. Choose which chats to include and click Export</p>
          <p>5. Upload the resulting <code>result.json</code> file here</p>
        </CardContent>
      </Card>
    </div>
  );
}
