import { cn } from "~/utils/cn";

export function BreadcrumbIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn("text-slate-650", className)}
      width="9"
      height="20"
      viewBox="0 0 9 26"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <line
        x1="8.32382"
        y1="0.6286"
        x2="0.6286"
        y2="24.6762"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
