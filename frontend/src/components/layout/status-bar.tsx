"use client";

import { useWebSocket } from "@/hooks/use-websocket";
import { Loader2, Menu, Wifi, WifiOff } from "lucide-react";
import { useMobileSidebar } from "@/components/layout/mobile-sidebar-context";

export function StatusBar() {
  const { connected, statusMessage } = useWebSocket();
  const { toggle } = useMobileSidebar();

  return (
    <div className="flex h-9 items-center justify-between border-b border-border-grid bg-surface-card px-3 sm:px-4">
      {/* Left: hamburger (mobile) + connection status */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="text-ink-secondary hover:text-ink-primary transition-colors lg:hidden"
          aria-label="Toggle navigation"
        >
          <Menu className="h-4 w-4" strokeWidth={1.5} />
        </button>
        <div className="flex items-center gap-1.5">
          {connected ? (
            <>
              <Wifi className="h-3 w-3 text-signal-success" strokeWidth={1.5} />
              <span className="text-label text-signal-success">
                Connected
              </span>
            </>
          ) : (
            <>
              <WifiOff className="h-3 w-3 text-signal-error" strokeWidth={1.5} />
              <span className="text-label text-signal-error">
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
            <Loader2 className="h-3 w-3 animate-spin text-primary" strokeWidth={1.5} />
            <span className="hidden text-[11px] text-ink-tertiary sm:inline">{statusMessage}</span>
          </>
        ) : (
          <span className="hidden text-[11px] text-ink-tertiary sm:inline">Idle</span>
        )}
      </div>

      {/* Right: spacer */}
      <div />
    </div>
  );
}
