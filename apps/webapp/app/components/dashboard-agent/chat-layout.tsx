// Transcript spacing lives here, so a card writes no spacing classes of its own.
export function ChatActionsRow({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1">{children}</div>;
}
