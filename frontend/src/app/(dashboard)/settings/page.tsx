"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Wifi, WifiOff, Loader2, CheckCircle2, ExternalLink, Brain, Zap, Sparkles, Crown, Power, Key, Eye, EyeOff, Trash2, AlertTriangle, Monitor, HardDrive, Database } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Telegram auth state
  const [step, setStep] = useState<"idle" | "code_sent" | "verifying" | "connected">("idle");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [phoneCodeHash, setPhoneCodeHash] = useState("");
  const [loading, setLoading] = useState(false);

  // AI settings state
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [showAnthropicApiKey, setShowAnthropicApiKey] = useState(false);
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [validatingAnthropicKey, setValidatingAnthropicKey] = useState(false);
  const [validatingOpenaiKey, setValidatingOpenaiKey] = useState(false);

  // Delete data state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  // Re-embed state
  const [showReembedDialog, setShowReembedDialog] = useState(false);
  const [pendingEmbeddingProvider, setPendingEmbeddingProvider] = useState<string | null>(null);

  // ── Queries ──

  const { data: tgStatus } = useQuery({
    queryKey: ["telegram-status"],
    queryFn: () =>
      api.settings.telegramStatus() as Promise<{
        connected: boolean;
        phone?: string;
        user_id?: string;
      }>,
    refetchInterval: 10000,
  });

  const { data: aiStatus } = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => api.settings.getAiStatus(),
  });

  const { data: modelData } = useQuery({
    queryKey: ["available-models"],
    queryFn: () => api.settings.availableModels(),
  });

  const { data: ollamaData } = useQuery({
    queryKey: ["ollama-status"],
    queryFn: () => api.settings.ollamaStatus(),
    refetchInterval: 30000,
  });

  const { data: embeddingData } = useQuery({
    queryKey: ["available-embeddings"],
    queryFn: () => api.settings.availableEmbeddings(),
  });

  // ── Mutations ──

  const modelMutation = useMutation({
    mutationFn: ({ modelId, provider }: { modelId: string; provider: string }) =>
      api.settings.updatePreferences({ llm_model: modelId, llm_provider: provider }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["available-models"] });
      queryClient.invalidateQueries({ queryKey: ["ai-status"] });
      toast.success("Model updated");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update model");
    },
  });

  const aiToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.settings.updatePreferences({ ai_enabled: enabled }),
    onSuccess: (_, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["ai-status"] });
      toast.success(enabled ? "AI features enabled" : "AI features disabled");
    },
    onError: () => {
      toast.error("Failed to update AI status");
    },
  });

  const apiKeyMutation = useMutation({
    mutationFn: async ({
      apiKey,
      provider,
    }: {
      apiKey: string | null;
      provider: "anthropic" | "openai";
    }) => {
      if (apiKey) {
        const result = await api.settings.validateApiKey(apiKey, provider);
        if (!result.valid) {
          throw new Error(result.message);
        }
      }
      if (provider === "anthropic") {
        return api.settings.updatePreferences({ anthropic_api_key: apiKey });
      }
      return api.settings.updatePreferences({ openai_api_key: apiKey });
    },
    onSuccess: (_, payload) => {
      queryClient.invalidateQueries({ queryKey: ["ai-status"] });
      queryClient.invalidateQueries({ queryKey: ["available-models"] });
      queryClient.invalidateQueries({ queryKey: ["available-embeddings"] });
      if (payload.provider === "anthropic") {
        setAnthropicApiKey("");
      } else {
        setOpenaiApiKey("");
      }
      toast.success(
        payload.apiKey
          ? `${payload.provider === "anthropic" ? "Anthropic" : "OpenAI"} API key saved`
          : `${payload.provider === "anthropic" ? "Anthropic" : "OpenAI"} API key removed`
      );
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save API key");
    },
  });

  const embeddingMutation = useMutation({
    mutationFn: async (prefs: Record<string, unknown>) => {
      const res = await api.settings.updatePreferences(prefs);
      return res as Record<string, unknown>;
    },
    onSuccess: (data: Record<string, unknown>) => {
      queryClient.invalidateQueries({ queryKey: ["available-embeddings"] });
      queryClient.invalidateQueries({ queryKey: ["ai-status"] });
      if (data.requires_reembed) {
        setShowReembedDialog(true);
      } else {
        toast.success("Embedding provider updated");
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update embedding provider");
    },
  });

  const reembedMutation = useMutation({
    mutationFn: () => api.settings.reembed(),
    onSuccess: (data) => {
      setShowReembedDialog(false);
      setPendingEmbeddingProvider(null);
      toast.success(data.message || "Re-embedding started");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to start re-embedding");
    },
  });

  const deleteDataMutation = useMutation({
    mutationFn: () => api.settings.deleteAllData({ confirm: true, keepAccount: true }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
      toast.success("All your data has been deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to delete data");
    },
  });

  // ── Handlers ──

  const handleRequestCode = async () => {
    if (!apiId || !apiHash || !phone) {
      toast.error("Please fill in all Telegram credentials");
      return;
    }
    setLoading(true);
    try {
      const res = (await api.settings.requestTelegramCode({
        api_id: parseInt(apiId),
        api_hash: apiHash,
        phone,
      })) as { phone_code_hash: string };
      setPhoneCodeHash(res.phone_code_hash);
      setStep("code_sent");
      toast.success("Verification code sent to your Telegram app");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to send code";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!code) return;
    setLoading(true);
    try {
      await api.settings.verifyTelegramCode({
        code,
        phone_code_hash: phoneCodeHash,
      });
      setStep("connected");
      queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      toast.success("Telegram connected!");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Verification failed";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAnthropicKey = async () => {
    if (!anthropicApiKey.trim()) return;
    setValidatingAnthropicKey(true);
    try {
      await apiKeyMutation.mutateAsync({ apiKey: anthropicApiKey.trim(), provider: "anthropic" });
    } finally {
      setValidatingAnthropicKey(false);
    }
  };

  const handleSaveOpenaiKey = async () => {
    if (!openaiApiKey.trim()) return;
    setValidatingOpenaiKey(true);
    try {
      await apiKeyMutation.mutateAsync({ apiKey: openaiApiKey.trim(), provider: "openai" });
    } finally {
      setValidatingOpenaiKey(false);
    }
  };

  const handleEmbeddingProviderChange = (providerId: string, model?: string) => {
    const currentProvider = embeddingData?.current?.provider;
    const prefs: Record<string, unknown> = { embedding_provider: providerId };
    if (providerId === "ollama" && model) {
      prefs.ollama_embedding_model = model;
    }
    setPendingEmbeddingProvider(providerId);
    if (currentProvider && currentProvider !== providerId) {
      embeddingMutation.mutate(prefs);
    } else {
      embeddingMutation.mutate(prefs);
    }
  };

  const tierIcon = (tier: string) => {
    switch (tier) {
      case "fast":
        return <Zap className="h-4 w-4" strokeWidth={1.5} />;
      case "balanced":
        return <Sparkles className="h-4 w-4" strokeWidth={1.5} />;
      case "premium":
        return <Crown className="h-4 w-4" strokeWidth={1.5} />;
      case "local":
        return <Monitor className="h-4 w-4" strokeWidth={1.5} />;
      default:
        return <Brain className="h-4 w-4" strokeWidth={1.5} />;
    }
  };

  const isConnected = tgStatus?.connected || step === "connected";

  // Group models by provider for the selector
  const modelsByProvider = modelData?.models.reduce(
    (acc, m) => {
      const key = m.provider;
      if (!acc[key]) acc[key] = [];
      acc[key].push(m);
      return acc;
    },
    {} as Record<string, typeof modelData.models>
  ) ?? {};

  const providerLabels: Record<string, string> = {
    ollama: "Local Models (Ollama)",
    anthropic: "Anthropic",
    openai: "OpenAI",
  };
  const providerOrder = ["ollama", "anthropic", "openai"];
  const selectedLocalModel = ollamaData?.chat_models?.find(
    (m) => m.id === modelData?.current
  )?.id;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1 text-ink-primary">Settings</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Configure your Telegram connection, AI providers, and preferences
        </p>
      </div>

      {/* Telegram Connection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                {isConnected ? (
                  <Wifi className="h-4 w-4 text-signal-success" strokeWidth={1.5} />
                ) : (
                  <WifiOff className="h-4 w-4 text-signal-warning" strokeWidth={1.5} />
                )}
                Telegram Connection
              </CardTitle>
              <CardDescription>
                Connect your personal Telegram account for live monitoring
              </CardDescription>
            </div>
            <Badge variant={isConnected ? "default" : "secondary"}>
              {isConnected ? "Connected" : "Not Connected"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected ? (
            <div className="flex items-center gap-3 border border-signal-success/20 bg-signal-success/5 p-4">
              <CheckCircle2 className="h-5 w-5 text-signal-success" strokeWidth={1.5} />
              <div>
                <p className="text-sm text-signal-success">Telegram is connected</p>
                <p className="text-xs text-signal-success/70">
                  Live monitoring is active. New messages will appear in your inbox.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-sm text-ink-primary">
                    Step 1: Get API credentials from{" "}
                    <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-[#4B8AFF] transition-colors">
                      my.telegram.org <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} />
                    </a>
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input placeholder="API ID" value={apiId} onChange={(e) => setApiId(e.target.value)} disabled={step !== "idle" || loading} />
                  <Input placeholder="API Hash" value={apiHash} onChange={(e) => setApiHash(e.target.value)} disabled={step !== "idle" || loading} />
                </div>
                <Input placeholder="Phone number (with country code, e.g. +1234567890)" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={step !== "idle" || loading} />
                {step === "idle" && (
                  <Button onClick={handleRequestCode} disabled={loading || !apiId || !apiHash || !phone}>
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : null}
                    Send Verification Code
                  </Button>
                )}
              </div>
              {step === "code_sent" && (
                <div className="space-y-3 border-t border-border-grid pt-4">
                  <p className="text-sm text-ink-primary">Step 2: Enter the verification code sent to your Telegram app</p>
                  <div className="flex gap-2">
                    <Input placeholder="Verification code" value={code} onChange={(e) => setCode(e.target.value)} disabled={loading} />
                    <Button onClick={handleVerifyCode} disabled={loading || !code}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : null}
                      Verify
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* AI Kill Switch */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Power className="h-4 w-4 text-signal-error" strokeWidth={1.5} />
                AI Kill Switch
              </CardTitle>
              <CardDescription>Instantly disable all AI features to stop API costs</CardDescription>
            </div>
            <Badge variant={aiStatus?.ai_enabled ? "default" : "destructive"}>
              {aiStatus?.ai_enabled ? "Active" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-4 border border-border-element">
            <div>
              <p className="text-sm text-ink-primary">Enable AI Features</p>
              <p className="text-xs text-ink-tertiary mt-0.5">
                {aiStatus?.ai_enabled ? "AI ghostwriting, summaries, and queries are active" : "All AI features are disabled — no API calls will be made"}
              </p>
            </div>
            <Switch checked={aiStatus?.ai_enabled ?? true} onCheckedChange={(checked) => aiToggleMutation.mutate(checked)} disabled={aiToggleMutation.isPending} />
          </div>
          {!aiStatus?.ai_enabled && (
            <div className="mt-3 p-3 border border-signal-warning/20 bg-signal-warning/5">
              <p className="text-xs text-signal-warning">AI is currently disabled. Enable it above to use ghostwriting and other AI features.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Local AI (Ollama) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Monitor className="h-4 w-4 text-primary" strokeWidth={1.5} />
                Local AI (Ollama)
              </CardTitle>
              <CardDescription>Run models locally for privacy and zero cost</CardDescription>
            </div>
            <Badge variant={ollamaData?.reachable ? "default" : "secondary"}>
              {ollamaData?.reachable ? "Connected" : "Not Detected"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {ollamaData?.reachable ? (
            <>
              <div className="flex items-center gap-3 border border-signal-success/20 bg-signal-success/5 p-4">
                <CheckCircle2 className="h-5 w-5 text-signal-success" strokeWidth={1.5} />
                <div>
                  <p className="text-sm text-signal-success">Ollama is running</p>
                  <p className="text-xs text-signal-success/70">
                    {ollamaData.chat_models.length} chat model{ollamaData.chat_models.length !== 1 ? "s" : ""},{" "}
                    {ollamaData.embedding_models.length} embedding model{ollamaData.embedding_models.length !== 1 ? "s" : ""} available
                  </p>
                </div>
              </div>
              {ollamaData.chat_models.length > 0 && (
                <div className="p-4 border border-border-element space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-ink-primary">Local LLM Model</p>
                    <Badge variant={selectedLocalModel ? "default" : "secondary"}>
                      {selectedLocalModel ? "Selected" : "Not selected"}
                    </Badge>
                  </div>
                  <p className="text-xs text-ink-tertiary">
                    Pick which Ollama model should be used for local generation.
                  </p>
                  <div className="space-y-2">
                    {ollamaData.chat_models.map((model) => {
                      const isSelected = model.id === modelData?.current;
                      return (
                        <button
                          key={model.id}
                          onClick={() => {
                            if (!isSelected) {
                              modelMutation.mutate({
                                modelId: model.id,
                                provider: "ollama",
                              });
                            }
                          }}
                          disabled={modelMutation.isPending || !aiStatus?.ai_enabled}
                          className={`w-full text-left p-3 border transition-colors ${
                            isSelected
                              ? "border-primary bg-[color:var(--color-accent-subtle)]"
                              : "border-border-element hover:border-border-grid"
                          } ${modelMutation.isPending || !aiStatus?.ai_enabled ? "opacity-50" : ""}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-ink-primary">{model.name}</span>
                            <span className="text-xs text-signal-success font-mono">Free</span>
                          </div>
                          <p className="text-xs text-ink-tertiary mt-0.5">{model.id}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {ollamaData.chat_models.length === 0 && ollamaData.embedding_models.length === 0 && (
                <div className="p-3 border border-signal-warning/20 bg-signal-warning/5">
                  <p className="text-xs text-signal-warning mb-2">No models pulled yet. Run these commands to get started:</p>
                  <div className="space-y-1">
                    <code className="block text-xs font-mono text-ink-secondary bg-surface-raised px-2 py-1">ollama pull llama3.2</code>
                    <code className="block text-xs font-mono text-ink-secondary bg-surface-raised px-2 py-1">ollama pull nomic-embed-text</code>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="p-4 border border-border-element space-y-3">
              <p className="text-sm text-ink-secondary">
                Ollama is not detected. Install it to use local AI models with zero API costs.
              </p>
              <div className="space-y-2">
                <p className="text-xs text-ink-tertiary">
                  1. Install from{" "}
                  <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-[#4B8AFF] transition-colors">
                    ollama.com/download <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} />
                  </a>
                </p>
                <p className="text-xs text-ink-tertiary">2. Start with <code className="font-mono bg-surface-raised px-1">ollama serve</code></p>
                <p className="text-xs text-ink-tertiary">3. Pull models: <code className="font-mono bg-surface-raised px-1">ollama pull llama3.2</code></p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Keys */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Key className="h-4 w-4 text-primary" strokeWidth={1.5} />
                Cloud API Keys
              </CardTitle>
              <CardDescription>Bring your own provider keys for cloud models.</CardDescription>
            </div>
            {(aiStatus?.has_anthropic_api_key || aiStatus?.has_openai_api_key) && (
              <Badge variant="default">Custom Key Active</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 border border-border-element space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-primary">Anthropic key (Claude models)</p>
                <p className="text-xs text-ink-tertiary mt-0.5">Needed only if you select a Claude model.</p>
              </div>
              {aiStatus?.has_anthropic_api_key && <Badge variant="default">Configured</Badge>}
            </div>
            {aiStatus?.has_anthropic_api_key ? (
              <div className="flex items-center justify-between p-3 border border-signal-success/20 bg-signal-success/5">
                <div>
                  <p className="text-sm text-signal-success">Anthropic API key configured</p>
                  <p className="text-xs text-signal-success/70">Claude requests are billed to your Anthropic account.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => apiKeyMutation.mutate({ apiKey: null, provider: "anthropic" })} disabled={apiKeyMutation.isPending} className="text-signal-error hover:text-signal-error">
                  <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} /> Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showAnthropicApiKey ? "text" : "password"} placeholder="sk-ant-api03-..." value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} disabled={validatingAnthropicKey} />
                    <button type="button" onClick={() => setShowAnthropicApiKey(!showAnthropicApiKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary">
                      {showAnthropicApiKey ? <EyeOff className="h-4 w-4" strokeWidth={1.5} /> : <Eye className="h-4 w-4" strokeWidth={1.5} />}
                    </button>
                  </div>
                  <Button onClick={handleSaveAnthropicKey} disabled={!anthropicApiKey.trim() || validatingAnthropicKey}>
                    {validatingAnthropicKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : null} Save
                  </Button>
                </div>
                <p className="text-xs text-ink-tertiary">
                  Get key: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-[#4B8AFF] transition-colors">console.anthropic.com <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} /></a>
                </p>
              </div>
            )}
          </div>

          <div className="p-4 border border-border-element space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-primary">OpenAI key (embeddings + GPT models)</p>
                <p className="text-xs text-ink-tertiary mt-0.5">Used for embeddings and OpenAI chat models.</p>
              </div>
              {aiStatus?.has_openai_api_key && <Badge variant="default">Configured</Badge>}
            </div>
            {aiStatus?.has_openai_api_key ? (
              <div className="flex items-center justify-between p-3 border border-signal-success/20 bg-signal-success/5">
                <div>
                  <p className="text-sm text-signal-success">OpenAI API key configured</p>
                  <p className="text-xs text-signal-success/70">Embeddings and GPT requests are billed to your OpenAI account.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => apiKeyMutation.mutate({ apiKey: null, provider: "openai" })} disabled={apiKeyMutation.isPending} className="text-signal-error hover:text-signal-error">
                  <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} /> Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showOpenaiApiKey ? "text" : "password"} placeholder="sk-proj-..." value={openaiApiKey} onChange={(e) => setOpenaiApiKey(e.target.value)} disabled={validatingOpenaiKey} />
                    <button type="button" onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary">
                      {showOpenaiApiKey ? <EyeOff className="h-4 w-4" strokeWidth={1.5} /> : <Eye className="h-4 w-4" strokeWidth={1.5} />}
                    </button>
                  </div>
                  <Button onClick={handleSaveOpenaiKey} disabled={!openaiApiKey.trim() || validatingOpenaiKey}>
                    {validatingOpenaiKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : null} Save
                  </Button>
                </div>
                <p className="text-xs text-ink-tertiary">
                  Get key: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-[#4B8AFF] transition-colors">platform.openai.com <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} /></a>
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Embedding Provider */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="h-4 w-4 text-primary" strokeWidth={1.5} />
                Embedding Provider
              </CardTitle>
              <CardDescription>Choose how conversation data is indexed for retrieval</CardDescription>
            </div>
            {embeddingData?.current && (
              <Badge variant="default">
                {embeddingData.current.provider === "ollama" ? "Local" : embeddingData.current.provider}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {embeddingData?.providers.map((provider) => {
            const isCurrent = provider.id === embeddingData.current.provider;
            const disabled = !provider.available || embeddingMutation.isPending;
            return (
              <button
                key={provider.id}
                onClick={() => {
                  if (!isCurrent && provider.available) {
                    handleEmbeddingProviderChange(
                      provider.id,
                      provider.id === "ollama" ? provider.model : undefined
                    );
                  }
                }}
                disabled={disabled}
                className={`w-full text-left p-4 border transition-colors ${
                  isCurrent
                    ? "border-primary bg-[color:var(--color-accent-subtle)]"
                    : provider.available
                      ? "border-border-element hover:border-border-grid"
                      : "border-border-element opacity-50 cursor-not-allowed"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={isCurrent ? "text-primary" : "text-ink-tertiary"}>
                      {provider.id === "ollama" ? (
                        <HardDrive className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Database className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${isCurrent ? "text-ink-primary" : "text-ink-secondary"}`}>
                          {provider.name}
                        </span>
                        {!provider.available && (
                          <span className="text-label text-signal-warning uppercase tracking-widest">
                            {provider.id === "ollama" ? "not detected" : "no api key"}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-tertiary mt-0.5">{provider.model}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-ink-tertiary">{provider.cost}</div>
                  </div>
                </div>
              </button>
            );
          })}
          <div className="p-3 border border-border-element bg-surface-raised/50 text-xs text-ink-tertiary">
            Switching providers requires re-indexing all your data. This runs in the background.
          </div>
        </CardContent>
      </Card>

      {/* LLM Model Selection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Brain className="h-4 w-4 text-primary" strokeWidth={1.5} />
                AI Model
              </CardTitle>
              <CardDescription>Choose the model used for ghostwriting, summaries, and chat queries</CardDescription>
            </div>
            {modelData?.current && (
              <Badge variant="default">
                {modelData.models.find((m) => m.id === modelData.current)?.name ?? modelData.current}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {modelData?.models && modelData.models.length === 0 && (
            <div className="p-4 border border-signal-warning/20 bg-signal-warning/5 text-sm text-signal-warning">
              No AI providers available. Add an API key above or install Ollama for local models.
            </div>
          )}
          {providerOrder.map((providerKey) => {
            const models = modelsByProvider[providerKey];
            if (!models || models.length === 0) return null;
            return (
              <div key={providerKey} className="space-y-2">
                <p className="text-xs font-medium text-ink-tertiary uppercase tracking-widest">
                  {providerLabels[providerKey] ?? providerKey}
                </p>
                {models.map((model) => {
                  const isSelected = model.id === modelData?.current;
                  const isDefault = model.id === modelData?.default;
                  const isLocal = model.provider === "ollama";
                  return (
                    <button
                      key={model.id}
                      onClick={() => {
                        if (!isSelected) modelMutation.mutate({ modelId: model.id, provider: model.provider });
                      }}
                      disabled={modelMutation.isPending || !aiStatus?.ai_enabled}
                      className={`w-full text-left p-4 border transition-colors ${
                        isSelected
                          ? "border-primary bg-[color:var(--color-accent-subtle)]"
                          : "border-border-element hover:border-border-grid"
                      } ${modelMutation.isPending || !aiStatus?.ai_enabled ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={isSelected ? "text-primary" : "text-ink-tertiary"}>
                            {tierIcon(model.tier)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`text-sm ${isSelected ? "text-ink-primary" : "text-ink-secondary"}`}>
                                {model.name}
                              </span>
                              {isDefault && (
                                <span className="text-label text-ink-tertiary uppercase tracking-widest">default</span>
                              )}
                            </div>
                            <p className="text-xs text-ink-tertiary mt-0.5">{model.description}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          {isLocal ? (
                            <div className="font-mono text-xs text-signal-success">Free</div>
                          ) : (
                            <>
                              <div className="font-mono text-xs text-ink-tertiary tabular-nums">
                                ${model.input_cost_per_m}/{model.output_cost_per_m}
                              </div>
                              <div className="text-label text-ink-tertiary uppercase tracking-widest">per 1M tok</div>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Account Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-label text-ink-tertiary">Name</span>
            <span className="text-ink-primary">{user?.name}</span>
          </div>
          <div className="border-t border-border-element" />
          <div className="flex justify-between">
            <span className="text-label text-ink-tertiary">Email</span>
            <span className="text-ink-primary">{user?.email}</span>
          </div>
          {user?.telegram_user_id && (
            <>
              <div className="border-t border-border-element" />
              <div className="flex justify-between">
                <span className="text-label text-ink-tertiary">Telegram ID</span>
                <span className="text-ink-primary font-mono">{user.telegram_user_id}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-signal-error/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm text-signal-error">
                <AlertTriangle className="h-4 w-4" strokeWidth={1.5} />
                Danger Zone
              </CardTitle>
              <CardDescription>Permanently delete all your data</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="p-4 border border-signal-error/20 bg-signal-error/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-ink-primary font-medium">Delete All Data</p>
                <p className="text-xs text-ink-tertiary mt-1">
                  Permanently delete all your contacts, messages, documents, suggestions, and disconnect your Telegram account. This action cannot be undone.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowDeleteDialog(true)} className="shrink-0 border-signal-error/50 text-signal-error hover:bg-signal-error/10 hover:text-signal-error">
                <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} /> Delete All Data
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Re-embed Confirmation Dialog */}
      <Dialog open={showReembedDialog} onOpenChange={setShowReembedDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" strokeWidth={1.5} />
              Re-index Required
            </DialogTitle>
            <DialogDescription>
              Switching embedding providers requires re-indexing all your conversation and document data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-ink-secondary">
              This runs in the background and may take a few minutes depending on how much data you have. Your app will continue working during the process.
            </p>
            <div className="p-3 border border-signal-warning/30 bg-signal-warning/5 text-xs text-signal-warning">
              Search quality may be reduced until re-indexing completes.
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowReembedDialog(false);
                setPendingEmbeddingProvider(null);
              }}
              disabled={reembedMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={() => reembedMutation.mutate()} disabled={reembedMutation.isPending}>
              {reembedMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : null}
              Re-index Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-signal-error">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.5} />
              Delete All Data
            </DialogTitle>
            <DialogDescription>This will permanently delete all your data including:</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <ul className="text-sm text-ink-secondary space-y-1.5 list-disc list-inside">
              <li>All contacts and their messages</li>
              <li>All conversation history and embeddings</li>
              <li>All uploaded documents</li>
              <li>All AI suggestions</li>
              <li>Your Telegram connection</li>
              <li>All settings and preferences</li>
            </ul>
            <div className="p-3 border border-signal-warning/30 bg-signal-warning/5 text-sm">
              <p className="text-signal-warning font-medium">This action cannot be undone.</p>
              <p className="text-ink-tertiary text-xs mt-1">Your account will remain active, but all data will be permanently deleted.</p>
            </div>
            <div className="pt-2">
              <label className="text-sm text-ink-secondary">
                Type <span className="font-mono font-bold">DELETE</span> to confirm:
              </label>
              <Input className="mt-2" placeholder="Type DELETE" value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} disabled={deleteDataMutation.isPending} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(""); }} disabled={deleteDataMutation.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (deleteConfirmText === "DELETE") deleteDataMutation.mutate(); }} disabled={deleteConfirmText !== "DELETE" || deleteDataMutation.isPending}>
              {deleteDataMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} /> : <Trash2 className="mr-2 h-4 w-4" strokeWidth={1.5} />}
              Delete All Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
