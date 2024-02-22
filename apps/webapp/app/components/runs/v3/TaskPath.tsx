import { SpanCodePathAccessory } from "./SpanTitle";

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
