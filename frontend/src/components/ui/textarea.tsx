import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-border-grid placeholder:text-ink-tertiary focus-visible:border-primary focus-visible:ring-primary/20 aria-invalid:ring-signal-error/20 aria-invalid:border-signal-error bg-surface-card flex field-sizing-content min-h-16 w-full border px-3 py-2 text-sm text-ink-primary transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
