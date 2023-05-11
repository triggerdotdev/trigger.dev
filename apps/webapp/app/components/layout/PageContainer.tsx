import { cn } from "~/utils/cn";

export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-y-auto px-4 py-4 md:px-8 md:py-6 lg:px-12 lg:py-10",
        className
      )}
    >
      {children}
    </div>
  );
}
