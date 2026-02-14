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
          {!isLoading && costs && costs.daily_costs.length > 0 && (
            <p className="text-xs text-ink-tertiary font-mono">
              Peak: {formatCost(maxDailyCost)} / day
            </p>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : (costs?.daily_costs ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-tertiary">
              No usage recorded yet
            </p>
          ) : (() => {
            const labelStep = Math.max(1, Math.floor(costs!.daily_costs.length / 6));
            return (
              <div className="overflow-x-auto">
                <div style={{ minWidth: "20rem" }}>
                  {/* Y-axis + Bars */}
                  <div className="flex">
                    {/* Y-axis labels */}
                    <div className="flex h-48 w-10 shrink-0 flex-col justify-between pr-2 text-right">
                      <span className="text-[10px] text-ink-tertiary font-mono leading-none">
                        {formatCost(maxDailyCost)}
                      </span>
                      <span className="text-[10px] text-ink-tertiary font-mono leading-none">
                        {formatCost(maxDailyCost / 2)}
                      </span>
                      <span className="text-[10px] text-ink-tertiary font-mono leading-none">
                        $0
                      </span>
                    </div>
                    {/* Chart area */}
                    <div className="relative flex-1">
                      {/* Grid lines */}
                      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                        <div className="border-t border-border-grid/50" />
                        <div className="border-t border-dashed border-border-grid/30" />
                        <div className="border-t border-border-grid/50" />
                      </div>
                      {/* Bars */}
                      <div className="relative flex h-48 items-end gap-px">
                        {costs!.daily_costs.map((day, idx) => {
                          const heightPct = (day.cost_usd / maxDailyCost) * 100;
                          return (
                            <div
                              key={day.date}
                              className="group relative flex-1"
                              style={{ height: "100%" }}
                            >
                              {/* Tooltip */}
                              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border-grid bg-surface-card px-2.5 py-1.5 text-xs shadow-sm group-hover:block">
                                <p className="text-ink-primary font-mono font-medium">{day.date}</p>
                                <p className="font-mono text-primary">{formatCost(day.cost_usd)}</p>
                                <p className="text-ink-tertiary">{day.api_calls} calls</p>
                                <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-border-grid" />
                              </div>
                              {/* Bar (anchored to bottom) */}
                              <div className="absolute inset-x-0 bottom-0">
                                <div
                                  className="w-full bg-primary/60 transition-all duration-150 hover:bg-primary"
                                  style={{
                                    height: day.cost_usd > 0
                                      ? `${Math.max(heightPct, 1)}%`
                                      : "0px",
                                    minHeight: day.cost_usd > 0 ? "2px" : "0px",
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  {/* X-axis date labels — separate row, not inside chart height */}
                  <div className="flex pl-10">
                    {costs!.daily_costs.map((day, idx) => (
                      <div key={day.date} className="flex-1 text-center">
                        {idx % labelStep === 0 && (
                          <span className="mt-1.5 block text-[10px] text-ink-tertiary font-mono">
                            {day.date.slice(5)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}
