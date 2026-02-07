"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Contact, Message, Suggestion } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Sparkles,
  Send,
  X,
  Pencil,
  RotateCcw,
  User,
  Bot,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function ConversationPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const queryClient = useQueryClient();
  const [editText, setEditText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Fetch messages
  const { data: messagesData, isLoading: msgsLoading } = useQuery({
    queryKey: ["messages", contactId],
    queryFn: () =>
      api.contacts.messages(contactId, { limit: 100 }) as Promise<{
        messages: Message[];
        total: number;
        contact: Contact;
      }>,
    enabled: !!contactId,
  });

  // Fetch pending suggestions for this contact
  const { data: suggestionsData } = useQuery({
    queryKey: ["suggestions", contactId],
    queryFn: async () => {
      const res = (await api.suggestions.list("pending")) as {
        suggestions: Suggestion[];
      };
      return res.suggestions.filter((s) => s.contact_id === contactId);
    },
    enabled: !!contactId,
  });

  const contact = messagesData?.contact;
  const messages = messagesData?.messages ?? [];
  const suggestions = suggestionsData ?? [];

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.suggestions.generate(contactId);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      toast.success("Response generated!");
    } catch {
      toast.error("Failed to generate response");
    } finally {
      setGenerating(false);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await api.suggestions.approve(id);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
      toast.success("Message sent!");
    } catch {
      toast.error("Failed to send");
    }
  };

  const handleEdit = async (id: string) => {
    try {
      await api.suggestions.edit(id, editText);
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
      queryClient.invalidateQueries({ queryKey: ["messages", contactId] });
      toast.success("Edited message sent!");
    } catch {
      toast.error("Failed to send");
    }
  };

  const handleReject = async (id: string) => {
    try {
      await api.suggestions.reject(id);
      queryClient.invalidateQueries({ queryKey: ["suggestions", contactId] });
    } catch {
      toast.error("Failed to reject");
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Messages Panel */}
      <div className="flex flex-1 flex-col">
        {/* Contact Header */}
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary font-bold">
              {contact?.display_name?.charAt(0) ?? "?"}
            </div>
            <div>
              <h2 className="font-semibold">
                {contact?.display_name ?? "Loading..."}
              </h2>
              <p className="text-xs text-muted-foreground">
                {contact?.total_messages ?? 0} messages
                {contact?.unresponded_count
                  ? ` · ${contact.unresponded_count} unresponded`
                  : ""}
              </p>
            </div>
          </div>
          <Button
            onClick={handleGenerate}
            disabled={generating}
            size="sm"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {generating ? "Generating..." : "Generate Response"}
          </Button>
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 py-4">
          {msgsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className={cn("h-12 w-3/4 rounded-xl", i % 2 === 0 ? "" : "ml-auto")}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex",
                    msg.sender_type === "self" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[70%] rounded-2xl px-4 py-2.5",
                      msg.sender_type === "self"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    <p
                      className={cn(
                        "mt-1 text-[10px]",
                        msg.sender_type === "self"
                          ? "text-primary-foreground/60"
                          : "text-muted-foreground"
                      )}
                    >
                      {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Suggestion Cards */}
        {suggestions.length > 0 && (
          <div className="space-y-3 border-t pt-3">
            {suggestions.map((s) => (
              <Card key={s.id} className="border-primary/30 bg-primary/5">
                <CardContent className="py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Bot className="h-3.5 w-3.5" />
                    AI Suggested Response
                  </div>

                  {editingId === s.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleEdit(s.id)}
                        >
                          <Send className="mr-1 h-3 w-3" /> Send Edited
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm whitespace-pre-wrap">
                        {s.suggested_response}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleApprove(s.id)}
                        >
                          <Send className="mr-1 h-3 w-3" /> Send
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditText(s.suggested_response);
                            setEditingId(s.id);
                          }}
                        >
                          <Pencil className="mr-1 h-3 w-3" /> Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleReject(s.id)}
                        >
                          <X className="mr-1 h-3 w-3" /> Reject
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Contact Info Sidebar */}
      <div className="hidden w-64 shrink-0 space-y-4 border-l pl-4 lg:block">
        <h3 className="text-sm font-semibold">Contact Info</h3>
        <div className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground">Name</p>
            <p className="font-medium">{contact?.display_name}</p>
          </div>
          {contact?.username && (
            <div>
              <p className="text-muted-foreground">Username</p>
              <p className="font-medium">@{contact.username}</p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground">Auto-respond</p>
            <Badge variant={contact?.auto_respond ? "default" : "secondary"}>
              {contact?.auto_respond ? "On" : "Off"}
            </Badge>
          </div>
        </div>

        {contact?.style_profile && (
          <>
            <Separator />
            <div>
              <h3 className="mb-2 text-sm font-semibold">Style Profile</h3>
              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {contact.style_profile.slice(0, 500)}
                {contact.style_profile.length > 500 ? "..." : ""}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
