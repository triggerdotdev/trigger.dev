import { InlineCode, type InlineCodeVariant } from "~/components/code/InlineCode";
import { SpanCodePathAccessory } from "./SpanTitle";
import { cn } from "~/utils/cn";

type TaskPathProps = {
  filePath: string;
  functionName: string;
  className?: string;
};

export function TaskPath({ filePath, functionName, className }: TaskPathProps) {
  return (
    <SpanCodePathAccessory
      accessory={{
        items: [{ text: filePath }, { text: functionName }],
      }}
      className={className}
    />
  );
}

type TaskFunctionNameProps = {
  functionName: string;
  variant?: InlineCodeVariant;
  className?: string;
};

export function TaskFunctionName({ variant, functionName, className }: TaskFunctionNameProps) {
  return (
    <InlineCode variant={variant} className={cn("text-text-dimmed", className)}>
      {`${functionName}()`}
    </InlineCode>
  );
}
