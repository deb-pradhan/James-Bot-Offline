"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { MobileSidebarProvider } from "@/components/layout/mobile-sidebar-context";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-canvas">
        <div className="space-y-4 text-center">
          <Skeleton className="mx-auto h-14 w-14" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <MobileSidebarProvider>
      <div className="flex h-screen overflow-hidden bg-surface-canvas">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <StatusBar />
          <main className="flex-1 overflow-auto p-3 sm:p-4 lg:p-6">
            {children}
          </main>
        </div>
      </div>
    </MobileSidebarProvider>
  );
}
