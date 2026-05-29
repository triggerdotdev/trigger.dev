import { cn } from "~/utils/cn";
import { Paragraph } from "../Paragraph";

export function ChartBlankState({
  icon: Icon,
  message,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  message: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full w-full items-center justify-center", className)}>
      <div className="-mt-3 flex flex-col items-center gap-2">
        {Icon && <Icon className="size-12 text-charcoal-700" />}
        <Paragraph variant="small" className="text-text-dimmed/70">
          {message}
        </Paragraph>
      </div>
    </div>
  );
}
