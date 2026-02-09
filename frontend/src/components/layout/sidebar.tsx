"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Inbox,
  BookOpen,
  Upload,
  Settings,
  LogOut,
  DollarSign,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { useMobileSidebar } from "@/components/layout/mobile-sidebar-context";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/ingest", label: "Ingest", icon: Upload },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { open, close } = useMobileSidebar();

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "flex h-full w-56 shrink-0 flex-col border-r border-border-grid bg-surface-canvas",
          // Mobile: fixed drawer, hidden off-screen by default
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: always visible, static positioning
          "lg:static lg:z-auto lg:translate-x-0 lg:transition-none"
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-3 border-b border-border-grid px-4">
          <div className="flex h-7 w-7 items-center justify-center bg-primary text-primary-foreground text-xs font-medium">
            J
          </div>
          <span className="text-sm font-normal text-ink-primary tracking-tight">
            James Bot
          </span>
        </div>

        {/* Section Label */}
        <div className="px-4 pt-5 pb-2">
          <span className="text-label text-ink-tertiary">Navigation</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-px px-2">
          {navItems.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-primary border-l-2 border-primary"
                    : "text-ink-secondary hover:bg-surface-subtle hover:text-ink-primary border-l-2 border-transparent"
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4",
                    isActive
                      ? "text-primary"
                      : "text-ink-tertiary group-hover:text-ink-secondary"
                  )}
                  strokeWidth={1.5}
                />
                <span className="flex-1">{item.label}</span>
                {isActive && (
                  <ChevronRight className="h-3 w-3 text-primary" strokeWidth={1.5} />
                )}
              </Link>
            );
          })}
        </nav>

        {/* User info + logout */}
        <div className="border-t border-border-grid p-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink-primary">
                {user?.name || "User"}
              </p>
              <p className="truncate text-[11px] text-ink-tertiary">
                {user?.email}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              title="Logout"
              className="rounded-full"
            >
              <LogOut className="h-4 w-4 text-ink-tertiary" strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
