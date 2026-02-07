"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Contact } from "@/types";
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Inbox</h1>
        {hasUnresponded && (
          <Button onClick={handleRespondAll} size="sm">
            <Sparkles className="mr-2 h-4 w-4" />
            Respond to All Unresponded
          </Button>
        )}
      </div>

      {/* Search + Sort */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
          <ArrowUpDown className="mr-2 h-4 w-4" />
          {sort === "unresponded" ? "By Unresponded" : "By Recent"}
        </Button>
      </div>

      {/* Contact List */}
      <div className="space-y-2">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))
          : contacts.length === 0
            ? (
              <Card className="py-12 text-center">
                <p className="text-muted-foreground">
                  No contacts yet. Upload a Telegram export to get started.
                </p>
                <Button variant="link" asChild className="mt-2">
                  <Link href="/ingest">Upload Chat Export</Link>
                </Button>
              </Card>
            )
            : contacts.map((contact) => (
              <Link key={contact.id} href={`/inbox/${contact.id}`}>
                <div className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-muted/50">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-medium">
                      {contact.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">
                          {contact.display_name}
                        </p>
                        {contact.auto_respond && (
                          <Badge variant="outline" className="text-xs">
                            Auto
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {contact.total_messages} messages
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
