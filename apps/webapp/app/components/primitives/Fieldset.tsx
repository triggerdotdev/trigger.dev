import { cn } from "~/utils/cn";

export function Fieldset({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-col gap-y-5", className)}>{children}</div>;
}
