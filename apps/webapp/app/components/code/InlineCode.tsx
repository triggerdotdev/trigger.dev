import type { ReactNode } from "react";

const inlineCode =
  "px-1 py-0.5 text-sm rounded-md border border-slate-800 bg-slate-950 text-sky-200 font-mono text-sm";

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className={inlineCode}>{children}</code>;
}
