import type { InlineCodeVariant } from "~/components/code/InlineCode";
import { InlineCode } from "~/components/code/InlineCode";
import { cn } from "~/utils/cn";

type TaskFileNameProps = {
  fileName: string;
  variant?: InlineCodeVariant;
  className?: string;
};

export function TaskFileName({ variant, fileName, className }: TaskFileNameProps) {
  return (
    <InlineCode variant={variant} className={cn("text-text-dimmed", className)}>
      {`${fileName}`}
    </InlineCode>
  );
}
