"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { DashboardOverview, UnrespondedContact } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  MessageSquare,
  FileText,
  Database,
  AlertCircle,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function OverviewPage() {
  const router = useRouter();

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: () => api.dashboard.overview() as Promise<DashboardOverview>,
    refetchInterval: 10000,
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
    } catch {
      toast.error("Failed to generate responses");
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your James Bot assistant
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/ingest">Upload Chat Export</Link>
          </Button>
          {(overview?.unresponded_count ?? 0) > 0 && (
            <Button onClick={handleRespondAll}>
              <Sparkles className="mr-2 h-4 w-4" />
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
              <Wifi className="h-5 w-5 text-green-500" />
              <span className="font-medium text-green-600 dark:text-green-400">
                Telegram Connected
              </span>
              <span className="text-sm text-muted-foreground">
                — Live monitoring active
              </span>
            </>
          ) : (
            <>
              <WifiOff className="h-5 w-5 text-amber-500" />
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Telegram Not Connected
              </span>
              <Button variant="link" size="sm" asChild>
                <Link href="/settings">Connect in Settings</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="rounded-lg bg-primary/10 p-2.5">
                <stat.icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                {overviewLoading ? (
                  <Skeleton className="h-7 w-16" />
                ) : (
                  <p className="text-2xl font-bold">
                    {stat.value.toLocaleString()}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Alert Cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Unresponded */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">
              <AlertCircle className="mr-2 inline h-4 w-4 text-amber-500" />
              Unresponded ({overview?.unresponded_count ?? 0})
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox?sort=unresponded">View All</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {unrespondedLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))
            ) : (unresponded?.contacts ?? []).length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                All caught up!
              </p>
            ) : (
              (unresponded?.contacts ?? []).slice(0, 5).map((c) => (
                <div
                  key={c.contact_id}
                  className="flex cursor-pointer items-center justify-between rounded-md p-2 hover:bg-muted"
                  onClick={() => router.push(`/inbox/${c.contact_id}`)}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{c.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.last_message_preview || "No preview"}
                    </p>
                  </div>
                  <Badge variant="secondary">{c.unresponded_count}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Pending Suggestions */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">
              <Sparkles className="mr-2 inline h-4 w-4 text-primary" />
              Pending Suggestions ({overview?.pending_suggestions ?? 0})
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox">Review</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {(overview?.pending_suggestions ?? 0) === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No pending suggestions
              </p>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                You have {overview?.pending_suggestions} response
                {(overview?.pending_suggestions ?? 0) > 1 ? "s" : ""} waiting
                for review in your inbox.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
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
