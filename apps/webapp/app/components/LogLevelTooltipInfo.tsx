import { BookOpenIcon } from "@heroicons/react/20/solid";
import { LinkButton } from "./primitives/Buttons";
import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";

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
        <div className="mb-0.5">
          <Header3 className="text-blue-400">Info</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          General informational messages about task execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5">
          <Header3 className="text-warning">Warn</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Warning messages indicating potential issues that don't prevent execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5">
          <Header3 className="text-error">Error</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Error messages for failures and exceptions during task execution.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5">
          <Header3 className="text-charcoal-400">Debug</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Detailed diagnostic information for development and debugging.
        </Paragraph>
      </div>
      <div className="border-t border-charcoal-700 pt-4">
        <Header3>Tracing & Spans</Header3>
        <Paragraph variant="small" className="text-text-dimmed">
          Automatically track the flow of your code through task triggers, attempts, and HTTP
          requests. Create custom traces to monitor specific operations.
        </Paragraph>
      </div>
      <LinkButton
        to="https://trigger.dev/docs/logging#tracing-and-spans"
        variant="docs/small"
        LeadingIcon={BookOpenIcon}
      >
        Read docs
      </LinkButton>
    </div>
  );
}
