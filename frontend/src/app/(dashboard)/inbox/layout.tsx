"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { QueryPanel } from "@/components/inbox/query-panel";
import { cn } from "@/lib/utils";

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 384;
const STORAGE_KEY = "query-panel-width";

export default function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(DEFAULT_WIDTH);

  // Hydrate from localStorage + auto-collapse on mobile
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const w = Math.min(Math.max(parseInt(saved, 10), MIN_WIDTH), MAX_WIDTH);
      setPanelWidth(w);
      widthRef.current = w;
    }
    if (window.innerWidth < 1024) {
      setCollapsed(true);
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = widthRef.current;

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.min(
          Math.max(startWidth + (ev.clientX - startX), MIN_WIDTH),
          MAX_WIDTH,
        );
        widthRef.current = newWidth;
        setPanelWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsDragging(false);
        localStorage.setItem(STORAGE_KEY, String(widthRef.current));
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [],
  );

  // Double-click to reset width
  const handleDoubleClick = useCallback(() => {
    setPanelWidth(DEFAULT_WIDTH);
    widthRef.current = DEFAULT_WIDTH;
    localStorage.setItem(STORAGE_KEY, String(DEFAULT_WIDTH));
  }, []);

  return (
    <div
      className="relative flex overflow-hidden"
      style={{
        height: "calc(100vh - 2.25rem - 2 * var(--content-padding))",
        margin: "calc(-1 * var(--content-padding))",
      }}
    >
      <QueryPanel
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={panelWidth}
      />

      {/* Drag handle — desktop only, when panel is open */}
      {!collapsed && (
        <div
          className={cn(
            "hidden lg:flex shrink-0 items-stretch cursor-col-resize select-none group relative z-10",
          )}
          style={{ width: 0 }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
        >
          {/* Visible rule */}
          <div
            className={cn(
              "absolute inset-y-0 left-0 -translate-x-1/2 transition-all duration-150",
              isDragging
                ? "w-[3px] bg-primary shadow-[0_0_8px_rgba(21,99,255,0.3)]"
                : "w-px bg-border-grid group-hover:w-[3px] group-hover:bg-primary/40",
            )}
          />
          {/* Wider hit area for easier grabbing */}
          <div className="absolute inset-y-0 -left-[6px] w-[12px]" />
        </div>
      )}

      <div
        className="flex-1 min-w-0 min-h-0 overflow-auto"
        style={{ padding: "var(--content-padding)" }}
      >
        {children}
      </div>
    </div>
  );
}
