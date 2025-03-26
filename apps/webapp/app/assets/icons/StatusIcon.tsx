import { cn } from "~/utils/cn";

export function StatusIcon({ className }: { className?: string }) {
  return (
    <div className={cn("grid place-items-center", className)}>
      <div className="size-[75%] rounded-full border-2 border-text-dimmed" />
    </div>
  );
}
