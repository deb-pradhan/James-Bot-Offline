"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff, Loader2, CheckCircle2, ExternalLink } from "lucide-react";
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
