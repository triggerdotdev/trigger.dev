import { cn } from "~/utils/cn";

export function StepContentContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("mb-6 ml-9 mt-1", className)}>{children}</div>;
}
