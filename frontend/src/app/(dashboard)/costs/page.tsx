"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CostSummary } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign,
  Zap,
  Brain,
  Hash,
  TrendingUp,
  Calendar,
} from "lucide-react";

const SERVICE_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI Embeddings",
  voyageai: "Voyage AI Embeddings",
};

const OPERATION_LABELS: Record<string, string> = {
  ghostwrite: "Ghostwriting",
  query: "Chat Queries",
  style_analysis: "Style Analysis",
  embedding_document: "Document Embedding",
  embedding_query: "Query Embedding",
  embedding_ingest: "Ingestion Embedding",
};

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function CostsPage() {
  const { data: costs, isLoading } = useQuery({
    queryKey: ["dashboard-costs"],
    queryFn: () => api.dashboard.costs() as Promise<CostSummary>,
    refetchInterval: 30000,
  });

  const maxDailyCost = Math.max(
    ...(costs?.daily_costs.map((d) => d.cost_usd) ?? [0]),
    0.000001
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-h1 text-ink-primary">API Costs</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Track your AI spending across all services
        </p>
      </div>

      {/* Summary Cards — Bento Grid */}
      <div className="grid grid-cols-2 gap-px bg-border-grid lg:grid-cols-4">
        {[
          {
            label: "Total Spent",
            value: costs ? formatCost(costs.total_cost_usd) : null,
            icon: DollarSign,
            sub: `${costs?.total_api_calls ?? 0} API calls`,
          },
          {
            label: "Today",
            value: costs ? formatCost(costs.today_cost_usd) : null,
            icon: Calendar,
            sub: "since midnight UTC",
          },
          {
            label: "This Month",
            value: costs ? formatCost(costs.month_cost_usd) : null,
            icon: TrendingUp,
            sub: "current billing period",
          },
          {
            label: "Total API Calls",
            value: costs?.total_api_calls.toLocaleString() ?? null,
            icon: Zap,
            sub: `${formatTokens((costs?.total_llm_tokens_in ?? 0) + (costs?.total_llm_tokens_out ?? 0) + (costs?.total_embedding_tokens ?? 0))} tokens`,
          },
        ].map((stat) => (
          <Card key={stat.label} className="border-0">
            <CardContent className="flex items-center gap-4 py-5">
              <div className="flex h-9 w-9 items-center justify-center bg-accent">
                <stat.icon className="h-4 w-4 text-primary" strokeWidth={1.5} />
              </div>
              <div>
                {isLoading || stat.value === null ? (
                  <Skeleton className="h-7 w-20" />
                ) : (
                  <p className="text-2xl font-light font-mono text-ink-primary">{stat.value}</p>
                )}
                <p className="text-label text-ink-tertiary mt-0.5">{stat.label}</p>
                <p className="text-[11px] text-ink-tertiary font-mono">{stat.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Token Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Hash className="h-4 w-4 text-primary" strokeWidth={1.5} />
            Token Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-px bg-border-grid sm:grid-cols-3">
              <div className="bg-surface-card p-4">
                <p className="text-label text-ink-tertiary mb-1">LLM Input</p>
                <p className="text-xl font-light font-mono text-ink-primary">
                  {formatTokens(costs?.total_llm_tokens_in ?? 0)}
                </p>
              </div>
              <div className="bg-surface-card p-4">
                <p className="text-label text-ink-tertiary mb-1">LLM Output</p>
                <p className="text-xl font-light font-mono text-ink-primary">
                  {formatTokens(costs?.total_llm_tokens_out ?? 0)}
                </p>
              </div>
              <div className="bg-surface-card p-4">
                <p className="text-label text-ink-tertiary mb-1">Embedding</p>
                <p className="text-xl font-light font-mono text-ink-primary">
                  {formatTokens(costs?.total_embedding_tokens ?? 0)}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-px bg-border-grid lg:grid-cols-2">
        {/* By Service */}
        <Card className="border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Brain className="h-4 w-4 text-primary" strokeWidth={1.5} />
              Cost by Service
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (costs?.by_service ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-tertiary">
                No usage recorded yet
              </p>
            ) : (
              <div className="space-y-3">
                {costs!.by_service.map((s) => {
                  const pct =
                    costs!.total_cost_usd > 0
                      ? (s.cost_usd / costs!.total_cost_usd) * 100
                      : 0;
                  return (
                    <div key={s.service}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-ink-primary">
                          {SERVICE_LABELS[s.service] ?? s.service}
                        </span>
                        <span className="font-mono text-ink-primary">
                          {formatCost(s.cost_usd)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden bg-surface-subtle">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-ink-tertiary font-mono">
                          {s.api_calls}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-tertiary font-mono">
                        {formatTokens(s.total_input_tokens)} in
                        {s.total_output_tokens > 0 &&
                          ` / ${formatTokens(s.total_output_tokens)} out`}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* By Operation */}
        <Card className="border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Zap className="h-4 w-4 text-primary" strokeWidth={1.5} />
              Cost by Operation
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (costs?.by_operation ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-tertiary">
                No usage recorded yet
              </p>
            ) : (
              <div className="space-y-3">
                {costs!.by_operation.map((op) => {
                  const pct =
                    costs!.total_cost_usd > 0
                      ? (op.cost_usd / costs!.total_cost_usd) * 100
                      : 0;
                  return (
                    <div key={op.operation}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-ink-primary">
                          {OPERATION_LABELS[op.operation] ?? op.operation}
                        </span>
                        <span className="font-mono text-ink-primary">
                          {formatCost(op.cost_usd)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden bg-surface-subtle">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-ink-tertiary font-mono">
                          {op.api_calls}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Daily Costs Chart (last 30 days) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-primary" strokeWidth={1.5} />
            Daily Costs (Last 30 Days)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (costs?.daily_costs ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-tertiary">
              No usage recorded yet
            </p>
          ) : (
            <div className="overflow-x-auto">
            <div className="flex h-48 items-end gap-px" style={{ minWidth: "20rem" }}>
              {costs!.daily_costs.map((day) => {
                const heightPct = (day.cost_usd / maxDailyCost) * 100;
                const dateLabel = day.date.slice(5); // MM-DD
                return (
                  <div
                    key={day.date}
                    className="group relative flex flex-1 flex-col items-center"
                  >
                    {/* Tooltip */}
                    <div className="pointer-events-none absolute -top-14 z-10 hidden whitespace-nowrap border border-border-grid bg-surface-card px-2 py-1 text-xs group-hover:block">
                      <p className="text-ink-primary font-mono">{day.date}</p>
                      <p className="font-mono">{formatCost(day.cost_usd)}</p>
                      <p className="text-ink-tertiary">
                        {day.api_calls} calls
                      </p>
                    </div>
                    {/* Bar */}
                    <div className="w-full flex-1 flex items-end">
                      <div
                        className="w-full bg-primary/60 transition-all hover:bg-primary"
                        style={{
                          height: `${Math.max(heightPct, 2)}%`,
                          minHeight: "2px",
                        }}
                      />
                    </div>
                    {/* Date label (show every nth) */}
                    {costs!.daily_costs.indexOf(day) %
                      Math.max(
                        1,
                        Math.floor(costs!.daily_costs.length / 6)
                      ) ===
                      0 && (
                      <span className="mt-1 text-[10px] text-ink-tertiary font-mono">
                        {dateLabel}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
