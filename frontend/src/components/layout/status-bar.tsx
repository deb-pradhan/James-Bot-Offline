"use client";

import { useWebSocket } from "@/hooks/use-websocket";
import { cn } from "@/lib/utils";
import { Loader2, Wifi, WifiOff } from "lucide-react";

export function StatusBar() {
  const { connected, statusMessage } = useWebSocket();

  return (
    <div className="flex h-10 items-center justify-between border-b bg-card px-4 text-xs">
      {/* Left: connection status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          {connected ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-green-500" />
              <span className="text-green-600 dark:text-green-400">
                Connected
              </span>
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5 text-red-500" />
              <span className="text-red-600 dark:text-red-400">
                Disconnected
              </span>
            </>
          )}
        </div>
      </div>

      {/* Center: processing status */}
      <div className="flex items-center gap-2">
        {statusMessage ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="text-muted-foreground">{statusMessage}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Idle</span>
        )}
      </div>

      {/* Right: spacer */}
      <div />
    </div>
  );
}
