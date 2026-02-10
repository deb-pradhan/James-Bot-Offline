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
import { Wifi, WifiOff, Loader2, CheckCircle2, ExternalLink, Brain, Zap, Sparkles, Crown, Power, Key, Eye, EyeOff, Trash2 } from "lucide-react";
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
  const [customApiKey, setCustomApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [validatingKey, setValidatingKey] = useState(false);

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
    mutationFn: async (apiKey: string | null) => {
      if (apiKey) {
        // Validate first
        const result = await api.settings.validateApiKey(apiKey);
        if (!result.valid) {
          throw new Error(result.message);
        }
      }
      // Save to preferences
      return api.settings.updatePreferences({ anthropic_api_key: apiKey });
    },
    onSuccess: (_, apiKey) => {
      queryClient.invalidateQueries({ queryKey: ["ai-status"] });
      setCustomApiKey("");
      toast.success(apiKey ? "Custom API key saved" : "Custom API key removed");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save API key");
    },
  });

  const handleSaveApiKey = async () => {
    if (!customApiKey.trim()) return;
    setValidatingKey(true);
    try {
      await apiKeyMutation.mutateAsync(customApiKey.trim());
    } finally {
      setValidatingKey(false);
    }
  };

  const handleRemoveApiKey = () => {
    apiKeyMutation.mutate(null);
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

      {/* Custom API Key */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Key className="h-4 w-4 text-primary" strokeWidth={1.5} />
                Custom Claude API Key
              </CardTitle>
              <CardDescription>
                Use your own Anthropic API key for AI features
              </CardDescription>
            </div>
            {aiStatus?.has_custom_api_key && (
              <Badge variant="default">Custom Key Active</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {aiStatus?.has_custom_api_key ? (
            <div className="flex items-center justify-between p-4 border border-signal-success/20 bg-signal-success/5">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-signal-success" strokeWidth={1.5} />
                <div>
                  <p className="text-sm text-signal-success">Custom API key configured</p>
                  <p className="text-xs text-signal-success/70">
                    All AI calls use your personal Anthropic API key
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemoveApiKey}
                disabled={apiKeyMutation.isPending}
                className="text-signal-error hover:text-signal-error"
              >
                <Trash2 className="h-4 w-4 mr-1" strokeWidth={1.5} />
                Remove
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-ink-secondary">
                  Enter your Anthropic API key to use your own account for AI features.
                  Get your key from{" "}
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
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showApiKey ? "text" : "password"}
                      placeholder="sk-ant-api03-..."
                      value={customApiKey}
                      onChange={(e) => setCustomApiKey(e.target.value)}
                      disabled={validatingKey}
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary"
                    >
                      {showApiKey ? (
                        <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </button>
                  </div>
                  <Button
                    onClick={handleSaveApiKey}
                    disabled={!customApiKey.trim() || validatingKey}
                  >
                    {validatingKey ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.5} />
                    ) : null}
                    Save Key
                  </Button>
                </div>
              </div>
              <div className="p-3 border border-border-element bg-surface-inset text-xs text-ink-tertiary">
                <p className="font-medium text-ink-secondary mb-1">Why use your own key?</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Direct billing to your Anthropic account</li>
                  <li>Access to your own rate limits</li>
                  <li>Full control over API usage</li>
                </ul>
              </div>
            </>
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
    </div>
  );
}
