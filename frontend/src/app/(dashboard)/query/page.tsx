"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { QueryResponse, SourceChunk } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Loader2, User, FileText } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SourceChunk[];
}

export default function QueryPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = (await api.chat.query(question)) as QueryResponse;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I couldn't find an answer. Try rephrasing your question.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Query Chat History</h1>
        <p className="text-muted-foreground">
          Ask questions about your conversations and documents
        </p>
      </div>

      {/* Chat Area */}
      <ScrollArea className="flex-1 rounded-lg border p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Search className="mb-4 h-12 w-12 text-muted-foreground/30" />
            <p className="text-lg font-medium text-muted-foreground">
              Ask anything about your chat history
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {[
                "What did I discuss with partner X last month?",
                "Summarize my conversations from this week",
                "When did we talk about the contract?",
                "Which contacts haven't I responded to?",
              ].map((example) => (
                <Button
                  key={example}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => setInput(example)}
                >
                  {example}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={i}>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {msg.role === "user" ? (
                    <User className="h-3 w-3" />
                  ) : (
                    <Search className="h-3 w-3" />
                  )}
                  {msg.role === "user" ? "You" : "James Bot"}
                </div>
                <Card>
                  <CardContent className="py-3">
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-3 space-y-1 border-t pt-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          Sources:
                        </p>
                        {msg.sources.map((s, j) => (
                          <div
                            key={j}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            {s.contact_name ? (
                              <Badge variant="outline" className="text-[10px]">
                                <User className="mr-1 h-2.5 w-2.5" />
                                {s.contact_name}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]">
                                <FileText className="mr-1 h-2.5 w-2.5" />
                                {s.document_name}
                              </Badge>
                            )}
                            <span className="truncate">
                              {s.text_preview.slice(0, 80)}...
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching and analyzing...
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <Input
          placeholder="Ask about your chat history..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <Button type="submit" disabled={loading || !input.trim()}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
