import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { LogLevel } from "./logs/LogLevel";

export function LogLevelTooltipInfo() {
  return (
    <div className="flex max-w-xs flex-col gap-4 p-1 pb-2">
      <div>
        <Header3>Log Levels</Header3>
        <Paragraph variant="small" className="text-text-dimmed">
          Structured logging helps you debug and monitor your tasks.
        </Paragraph>
      </div>
      <div>
        <div className="mb-1">
          <LogLevel level="INFO" />
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          General informational messages about task execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-1">
          <LogLevel level="WARN" />
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Warning messages indicating potential issues that don't prevent execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-1">
          <LogLevel level="ERROR" />
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Error messages for failures and exceptions during task execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-1">
          <LogLevel level="DEBUG" />
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Detailed diagnostic information for development and debugging.
        </Paragraph>
      </div>
    </div>
  );
}
