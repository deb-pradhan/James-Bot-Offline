"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Document } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Upload, Link as LinkIcon, Trash2, FileText, Globe } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

export default function KnowledgePage() {
  const queryClient = useQueryClient();
  const [urlInput, setUrlInput] = useState("");
  const [uploading, setUploading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["documents"],
    queryFn: () =>
      api.documents.list() as Promise<{
        documents: Document[];
        total: number;
      }>,
  });

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files?.length) return;

      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          toast.info(`Uploading ${file.name}...`);
          await api.ingest.document(file);
          toast.success(`${file.name} indexed!`);
        }
        queryClient.invalidateQueries({ queryKey: ["documents"] });
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
        e.target.value = "";
      }
    },
    [queryClient]
  );

  const handleUrlIngest = async () => {
    if (!urlInput.trim()) return;
    setUploading(true);
    try {
      toast.info("Fetching and indexing URL...");
      await api.ingest.url({ url: urlInput.trim() });
      setUrlInput("");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("URL content indexed!");
    } catch {
      toast.error("Failed to ingest URL");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await api.documents.delete(id);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success(`Deleted ${name}`);
    } catch {
      toast.error("Failed to delete");
    }
  };

  const documents = data?.documents ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Knowledge Base</h1>
        <p className="text-muted-foreground">
          Upload documents and URLs to enrich the AI&apos;s context
        </p>
      </div>

      {/* Upload Section */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* File Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4" /> Upload Documents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <label className="flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed p-8 transition-colors hover:border-primary/50 hover:bg-muted/50">
              <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
              <p className="font-medium">
                {uploading ? "Uploading..." : "Drop files or click to upload"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                PDF, DOCX, TXT, MD
              </p>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md"
                className="hidden"
                onChange={handleFileUpload}
                disabled={uploading}
              />
            </label>
          </CardContent>
        </Card>

        {/* URL Ingest */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" /> Ingest from URL
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="https://example.com/page"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                disabled={uploading}
              />
              <Button
                onClick={handleUrlIngest}
                disabled={uploading || !urlInput.trim()}
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                Ingest
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              We&apos;ll scrape the main content from the URL and index it
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Documents Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Indexed Documents ({data?.total ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : documents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No documents uploaded yet
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Chunks</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-[200px] truncate font-medium">
                      {doc.filename}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{doc.doc_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          doc.scope === "general" ? "secondary" : "default"
                        }
                      >
                        {doc.scope}
                      </Badge>
                    </TableCell>
                    <TableCell>{doc.chunk_count}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDistanceToNow(new Date(doc.uploaded_at), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(doc.id, doc.filename)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
