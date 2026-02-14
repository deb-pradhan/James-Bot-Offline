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
import { Wifi, WifiOff, Loader2, CheckCircle2, ExternalLink, Brain, Zap, Sparkles, Crown, Power, Key, Eye, EyeOff, Trash2, AlertTriangle } from "lucide-react";
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

  // Fetch current status
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

  // AI status
  const { data: aiStatus } = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => api.settings.getAiStatus(),
  });

  // LLM model selection
  const { data: modelData } = useQuery({
    queryKey: ["available-models"],
    queryFn: () => api.settings.availableModels(),
  });

  const modelMutation = useMutation({
    mutationFn: (modelId: string) =>
      api.settings.updatePreferences({ llm_model: modelId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["available-models"] });
      toast.success("Model updated");
    },
    onError: () => {
      toast.error("Failed to update model");
    },
  });

  // AI toggle mutation
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

  // Custom API key mutation
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

  const handleSaveAnthropicKey = async () => {
    if (!anthropicApiKey.trim()) return;
    setValidatingAnthropicKey(true);
    try {
      await apiKeyMutation.mutateAsync({
        apiKey: anthropicApiKey.trim(),
        provider: "anthropic",
      });
    } finally {
      setValidatingAnthropicKey(false);
    }
  };

  const handleRemoveAnthropicKey = () => {
    apiKeyMutation.mutate({ apiKey: null, provider: "anthropic" });
  };

  const handleSaveOpenaiKey = async () => {
    if (!openaiApiKey.trim()) return;
    setValidatingOpenaiKey(true);
    try {
      await apiKeyMutation.mutateAsync({
        apiKey: openaiApiKey.trim(),
        provider: "openai",
      });
    } finally {
      setValidatingOpenaiKey(false);
    }
  };

  const handleRemoveOpenaiKey = () => {
    apiKeyMutation.mutate({ apiKey: null, provider: "openai" });
  };

  // Delete all data mutation
  const deleteDataMutation = useMutation({
    mutationFn: () => api.settings.deleteAllData({ confirm: true, keepAccount: true }),
    onSuccess: () => {
      // Invalidate all queries to refresh data
      queryClient.invalidateQueries();
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
      toast.success("All your data has been deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to delete data");
    },
  });

  const handleDeleteAllData = () => {
    if (deleteConfirmText !== "DELETE") return;
    deleteDataMutation.mutate();
  };

  const tierIcon = (tier: string) => {
    switch (tier) {
      case "fast":
        return <Zap className="h-4 w-4" strokeWidth={1.5} />;
      case "balanced":
        return <Sparkles className="h-4 w-4" strokeWidth={1.5} />;
      case "premium":
        return <Crown className="h-4 w-4" strokeWidth={1.5} />;
      default:
        return <Brain className="h-4 w-4" strokeWidth={1.5} />;
    }
  };

  const isConnected = tgStatus?.connected || step === "connected";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1 text-ink-primary">Settings</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Configure your Telegram connection and preferences
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
                <p className="text-sm text-signal-success">
                  Telegram is connected
                </p>
                <p className="text-xs text-signal-success/70">
                  Live monitoring is active. New messages will appear in your
                  inbox.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Step 1: Credentials */}
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-sm text-ink-primary">
                    Step 1: Get API credentials from{" "}
                    <a
                      href="https://my.telegram.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-[#4B8AFF] transition-colors"
                    >
                      my.telegram.org
                      <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} />
                    </a>
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="API ID"
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value)}
                    disabled={step !== "idle" || loading}
                  />
                  <Input
                    placeholder="API Hash"
                    value={apiHash}
                    onChange={(e) => setApiHash(e.target.value)}
                    disabled={step !== "idle" || loading}
                  />
                </div>
                <Input
                  placeholder="Phone number (with country code, e.g. +1234567890)"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={step !== "idle" || loading}
                />
                {step === "idle" && (
                  <Button
                    onClick={handleRequestCode}
                    disabled={loading || !apiId || !apiHash || !phone}
                  >
                    {loading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
                    ) : null}
                    Send Verification Code
                  </Button>
                )}
              </div>

              {/* Step 2: Enter Code */}
              {step === "code_sent" && (
                <div className="space-y-3 border-t border-border-grid pt-4">
                  <p className="text-sm text-ink-primary">
                    Step 2: Enter the verification code sent to your Telegram
                    app
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Verification code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      disabled={loading}
                    />
                    <Button
                      onClick={handleVerifyCode}
                      disabled={loading || !code}
                    >
                      {loading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
                      ) : null}
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
              <CardDescription>
                Instantly disable all AI features to stop API costs
              </CardDescription>
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
                {aiStatus?.ai_enabled
                  ? "AI ghostwriting, summaries, and queries are active"
                  : "All AI features are disabled — no API calls will be made"}
              </p>
            </div>
            <Switch
              checked={aiStatus?.ai_enabled ?? true}
              onCheckedChange={(checked) => aiToggleMutation.mutate(checked)}
              disabled={aiToggleMutation.isPending}
            />
          </div>
          {!aiStatus?.ai_enabled && (
            <div className="mt-3 p-3 border border-signal-warning/20 bg-signal-warning/5">
              <p className="text-xs text-signal-warning">
                AI is currently disabled. Enable it above to use ghostwriting and other AI features.
              </p>
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
                LLM + Embedding API Keys
              </CardTitle>
              <CardDescription>
                Bring your own provider keys. OpenAI key is used for embeddings and GPT models.
              </CardDescription>
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
                <p className="text-xs text-ink-tertiary mt-0.5">
                  Needed only if you select a Claude model.
                </p>
              </div>
              {aiStatus?.has_anthropic_api_key && <Badge variant="default">Configured</Badge>}
            </div>
            {aiStatus?.has_anthropic_api_key ? (
              <div className="flex items-center justify-between p-3 border border-signal-success/20 bg-signal-success/5">
                <div>
                  <p className="text-sm text-signal-success">Anthropic API key configured</p>
                  <p className="text-xs text-signal-success/70">
                    Claude requests are billed to your Anthropic account.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveAnthropicKey}
                  disabled={apiKeyMutation.isPending}
                  className="text-signal-error hover:text-signal-error"
                >
                  <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} />
                  Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showAnthropicApiKey ? "text" : "password"}
                      placeholder="sk-ant-api03-..."
                      value={anthropicApiKey}
                      onChange={(e) => setAnthropicApiKey(e.target.value)}
                      disabled={validatingAnthropicKey}
                    />
                    <button
                      type="button"
                      onClick={() => setShowAnthropicApiKey(!showAnthropicApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary"
                    >
                      {showAnthropicApiKey ? (
                        <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </button>
                  </div>
                  <Button
                    onClick={handleSaveAnthropicKey}
                    disabled={!anthropicApiKey.trim() || validatingAnthropicKey}
                  >
                    {validatingAnthropicKey ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
                    ) : null}
                    Save
                  </Button>
                </div>
                <p className="text-xs text-ink-tertiary">
                  Get key:{" "}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:text-[#4B8AFF] transition-colors"
                  >
                    console.anthropic.com
                    <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} />
                  </a>
                </p>
              </div>
            )}
          </div>

          <div className="p-4 border border-border-element space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-primary">OpenAI key (embeddings + GPT models)</p>
                <p className="text-xs text-ink-tertiary mt-0.5">
                  Used for embeddings and OpenAI chat models.
                </p>
              </div>
              {aiStatus?.has_openai_api_key && <Badge variant="default">Configured</Badge>}
            </div>
            {aiStatus?.has_openai_api_key ? (
              <div className="flex items-center justify-between p-3 border border-signal-success/20 bg-signal-success/5">
                <div>
                  <p className="text-sm text-signal-success">OpenAI API key configured</p>
                  <p className="text-xs text-signal-success/70">
                    Embeddings and GPT requests are billed to your OpenAI account.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveOpenaiKey}
                  disabled={apiKeyMutation.isPending}
                  className="text-signal-error hover:text-signal-error"
                >
                  <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} />
                  Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showOpenaiApiKey ? "text" : "password"}
                      placeholder="sk-proj-..."
                      value={openaiApiKey}
                      onChange={(e) => setOpenaiApiKey(e.target.value)}
                      disabled={validatingOpenaiKey}
                    />
                    <button
                      type="button"
                      onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary"
                    >
                      {showOpenaiApiKey ? (
                        <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </button>
                  </div>
                  <Button
                    onClick={handleSaveOpenaiKey}
                    disabled={!openaiApiKey.trim() || validatingOpenaiKey}
                  >
                    {validatingOpenaiKey ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
                    ) : null}
                    Save
                  </Button>
                </div>
                <p className="text-xs text-ink-tertiary">
                  Get key:{" "}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:text-[#4B8AFF] transition-colors"
                  >
                    platform.openai.com
                    <ExternalLink className="ml-1 inline h-3 w-3" strokeWidth={1.5} />
                  </a>
                </p>
              </div>
            )}
          </div>

          {!aiStatus?.can_use_embeddings && (
            <div className="p-3 border border-signal-warning/20 bg-signal-warning/5 text-xs text-signal-warning">
              Embeddings are unavailable. Add an OpenAI API key to enable retrieval and document indexing.
            </div>
          )}
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
              <CardDescription>
                Choose the model used for ghostwriting, summaries, and chat queries
              </CardDescription>
            </div>
            {modelData?.current && (
              <Badge variant="default">
                {modelData.models.find((m) => m.id === modelData.current)?.name ?? modelData.current}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {modelData?.models.map((model) => {
            const isSelected = model.id === modelData.current;
            const isDefault = model.id === modelData.default;
            return (
              <button
                key={model.id}
                onClick={() => {
                  if (!isSelected) modelMutation.mutate(model.id);
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
                    <div
                      className={`${
                        isSelected ? "text-primary" : "text-ink-tertiary"
                      }`}
                    >
                      {tierIcon(model.tier)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm ${
                            isSelected ? "text-ink-primary" : "text-ink-secondary"
                          }`}
                        >
                          {model.name}
                        </span>
                        {isDefault && (
                          <span className="text-label text-ink-tertiary uppercase tracking-widest">
                            default
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-tertiary mt-0.5">
                        {model.description}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-ink-tertiary tabular-nums">
                      ${model.input_cost_per_m}/{model.output_cost_per_m}
                    </div>
                    <div className="text-label text-ink-tertiary uppercase tracking-widest">
                      per 1M tok
                    </div>
                  </div>
                </div>
              </button>
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

      {/* Danger Zone - Delete Data */}
      <Card className="border-signal-error/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm text-signal-error">
                <AlertTriangle className="h-4 w-4" strokeWidth={1.5} />
                Danger Zone
              </CardTitle>
              <CardDescription>
                Permanently delete all your data
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="p-4 border border-signal-error/20 bg-signal-error/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-ink-primary font-medium">Delete All Data</p>
                <p className="text-xs text-ink-tertiary mt-1">
                  Permanently delete all your contacts, messages, documents, suggestions,
                  and disconnect your Telegram account. This action cannot be undone.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteDialog(true)}
                className="shrink-0 border-signal-error/50 text-signal-error hover:bg-signal-error/10 hover:text-signal-error"
              >
                <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} />
                Delete All Data
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-signal-error">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.5} />
              Delete All Data
            </DialogTitle>
            <DialogDescription>
              This will permanently delete all your data including:
            </DialogDescription>
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
              <p className="text-ink-tertiary text-xs mt-1">
                Your account will remain active, but all data will be permanently deleted.
              </p>
            </div>
            <div className="pt-2">
              <label className="text-sm text-ink-secondary">
                Type <span className="font-mono font-bold">DELETE</span> to confirm:
              </label>
              <Input
                className="mt-2"
                placeholder="Type DELETE"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                disabled={deleteDataMutation.isPending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteDialog(false);
                setDeleteConfirmText("");
              }}
              disabled={deleteDataMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAllData}
              disabled={deleteConfirmText !== "DELETE" || deleteDataMutation.isPending}
            >
              {deleteDataMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" strokeWidth={1.5} />
              )}
              Delete All Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
