"use client";

import { QueryPanel } from "@/components/inbox/query-panel";

export default function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative flex overflow-hidden"
      style={{
        height: "calc(100vh - 2.25rem - 2 * var(--content-padding))",
        margin: "calc(-1 * var(--content-padding))",
      }}
    >
      <QueryPanel />
      <div
        className="flex-1 min-w-0 min-h-0 overflow-auto"
        style={{ padding: "var(--content-padding)" }}
      >
        {children}
      </div>
    </div>
  );
}
