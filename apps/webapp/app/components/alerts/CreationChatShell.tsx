import type { ReactNode } from "react";
import { cn } from "~/utils/cn";

export type CreationChatPlacement = "floating" | "docked";

export function CreationChatShell({
  placement,
  title,
  children,
}: {
  placement: CreationChatPlacement;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="creation-chat-shell"
      data-placement={placement}
      data-title={title}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden",
        placement === "floating" &&
          "absolute bottom-4 right-4 w-[380px] rounded-xl border border-grid-bright bg-background-bright shadow-lg"
      )}
    >
      {children}
    </div>
  );
}
