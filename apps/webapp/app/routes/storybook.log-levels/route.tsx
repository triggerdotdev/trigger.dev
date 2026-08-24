import { LogLevel } from "~/components/logs/LogLevel";
import type { LogLevel as LogLevelValue } from "~/presenters/v3/LogsListPresenter.server";

/** Was exported from logUtils; kept here now that only the storybook needs it. */
const validLogLevels: LogLevelValue[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
import { Paragraph } from "~/components/primitives/Paragraph";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const SAMPLE_ROWS: { level: (typeof validLogLevels)[number]; message: string }[] = [
  { level: "INFO", message: "Task hello-world starting with payload { message: 'Hello' }" },
  { level: "DEBUG", message: "Resolved queue concurrency limit to 10" },
  { level: "WARN", message: "Retrying after failure (attempt 2 of 3)" },
  { level: "ERROR", message: "Error: fetch failed with status 503" },
  { level: "TRACE", message: "prisma:query SELECT id FROM TaskRun WHERE ..." },
];

export default function Story_() {
  return (
    <StoryPage
      componentNames={["LogLevel.tsx", "logUtils.ts"]}
      title="Log levels"
      description="The severity chip shown on every row of the Logs page."
    >
      <StorySection title="All levels">
        <StoryGrid min="9rem">
          {validLogLevels.map((level) => (
            <Story key={level} label={level.toLowerCase()}>
              <LogLevel level={level} />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="In context" description="As they sit against log messages.">
        <div className="flex flex-col gap-1.5 rounded-sm border border-grid-dimmed p-3">
          {SAMPLE_ROWS.map((row, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="w-16 shrink-0">
                <LogLevel level={row.level} />
              </span>
              <Paragraph variant="extra-small" className="truncate font-mono">
                {row.message}
              </Paragraph>
            </div>
          ))}
        </div>
      </StorySection>
    </StoryPage>
  );
}
