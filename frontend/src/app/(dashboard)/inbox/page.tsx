"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useWebSocket } from "@/hooks/use-websocket";
import type { Contact, WSEvent } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Search, Sparkles, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

export default function InboxPage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("last_message_at");
  const queryClient = useQueryClient();

  // Real-time: invalidate contacts list on new messages
  const handleWsEvent = useCallback(
    (event: WSEvent) => {
      if (
        event.type === "new_message" ||
        event.type === "suggestion_ready" ||
        event.type === "sync_complete"
      ) {
        queryClient.invalidateQueries({ queryKey: ["contacts"] });
      }
    },
    [queryClient],
  );
  useWebSocket(handleWsEvent);

  const { data, isLoading } = useQuery({
    queryKey: ["contacts", search, sort],
    queryFn: () =>
      api.contacts.list({ search: search || undefined, sort, limit: 100 }) as Promise<{
        contacts: Contact[];
        total: number;
      }>,
  });

  const handleRespondAll = async () => {
    toast.info("Generating responses for all unresponded contacts...");
    try {
      await api.suggestions.generateAll();
      toast.success("Responses generated!");
    } catch {
      toast.error("Failed to generate responses");
    }
  };

  const contacts = data?.contacts ?? [];
  const hasUnresponded = contacts.some((c) => c.unresponded_count > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-h1 text-ink-primary">Inbox</h1>
        {hasUnresponded && (
          <Button onClick={handleRespondAll} size="sm">
            <Sparkles className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            <span className="hidden sm:inline">Respond to All Unresponded</span>
            <span className="sm:hidden">Respond All</span>
          </Button>
        )}
      </div>

      {/* Search + Sort */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" strokeWidth={1.5} />
          <Input
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSort(sort === "unresponded" ? "last_message_at" : "unresponded")
          }
        >
          <ArrowUpDown className="mr-2 h-4 w-4" strokeWidth={1.5} />
          {sort === "unresponded" ? "By Unresponded" : "By Recent"}
        </Button>
      </div>

      {/* Contact List */}
      <div className="space-y-px">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))
          : contacts.length === 0
            ? (
              <Card className="py-12 text-center">
                <p className="text-ink-secondary">
                  No contacts yet. Upload a Telegram export to get started.
                </p>
                <Button variant="link" asChild className="mt-2">
                  <Link href="/ingest">Upload Chat Export</Link>
                </Button>
              </Card>
            )
            : contacts.map((contact) => (
              <Link key={contact.id} href={`/inbox/${contact.id}`}>
                <div className="flex items-center justify-between border border-border-element p-3 sm:p-4 transition-colors hover:bg-surface-subtle">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-accent text-primary text-sm">
                      {contact.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm text-ink-primary">
                          {contact.display_name}
                        </p>
                        {contact.auto_respond && (
                          <Badge variant="outline" className="text-[10px]">
                            Auto
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-ink-tertiary">
                        <span className="font-mono">{contact.total_messages}</span> messages
                        {contact.last_message_at &&
                          ` · ${formatDistanceToNow(new Date(contact.last_message_at), { addSuffix: true })}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {contact.unresponded_count > 0 && (
                      <Badge variant="destructive">
                        {contact.unresponded_count}
                      </Badge>
                    )}
                  </div>
                </div>
              </Link>
            ))}
      </div>
    </div>
  );
}
