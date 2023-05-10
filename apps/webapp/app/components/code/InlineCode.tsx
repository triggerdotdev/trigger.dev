import type { ReactNode } from "react";

const inlineCode =
  "px-1 py-0.5 text-sm bg-slate-700 border border-slate-900 rounded text-slate-200 font-mono";

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className={inlineCode}>{children}</code>;
}
