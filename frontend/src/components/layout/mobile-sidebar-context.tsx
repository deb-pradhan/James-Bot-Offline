"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

interface MobileSidebarCtx {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const Ctx = createContext<MobileSidebarCtx>({
  open: false,
  toggle: () => {},
  close: () => {},
});

export function MobileSidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((p) => !p), []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <Ctx.Provider value={{ open, toggle, close }}>{children}</Ctx.Provider>
  );
}

export const useMobileSidebar = () => useContext(Ctx);
