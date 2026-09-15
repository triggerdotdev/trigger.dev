import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunTag } from "~/components/runs/v3/RunTag";
import {
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
  TaskRunStatusIcon,
} from "~/components/runs/v3/TaskRunStatus";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/** Every icon name RunIcon resolves; unknown names fall back to the task icon. */
const RUN_ICON_NAMES = [
  "task",
  "task-cached",
  "agent",
  "scheduled",
  "attempt",
  "wait",
  "trace",
  "tag",
  "queue",
  "trigger",
  "python",
  "wait-token",
  "function",
  "query",
  "debug",
  "log",
  "info",
  "warn",
  "error",
  "fatal",
  "task-middleware",
  "task-fn-run",
  "task-hook-init",
  "task-hook-onStart",
  "task-hook-onStartAttempt",
  "task-hook-onSuccess",
  "task-hook-onWait",
  "task-hook-onResume",
  "task-hook-onComplete",
  "task-hook-cleanup",
  "task-hook-onCancel",
  "task-hook-onFailure",
  "task-hook-catchError",
  "streams",
  "hero-sparkles",
  "hero-wrench",
  "ai-provider-anthropic",
  "ai-provider-openai",
  "ai-provider-gemini",
  "ai-provider-llama",
  "ai-provider-deepseek",
  "ai-provider-xai",
  "ai-provider-perplexity",
  "ai-provider-cerebras",
  "ai-provider-mistral",
  "ai-provider-azure",
];

const SAMPLE_TAGS = [
  "production",
  "env:prod",
  "user_1234567",
  "version:2026.08.5",
  "org:acme-corp",
  "very-long-tag-name-that-should-truncate-nicely-in-the-ui",
];

export default function Story_() {
  return (
    <StoryPage
      componentNames={["TaskRunStatus.tsx", "RunIcon.tsx", "RunTag.tsx"]}
      title="Run statuses"
      description="Task run status combos, span icons and run tags, with every state."
    >
      <StorySection title="Status combos" description="TaskRunStatusCombo — all statuses.">
        <StoryGrid min="14rem">
          {allTaskRunStatuses.map((status) => (
            <Story key={status} label={status}>
              <SimpleTooltip
                button={<TaskRunStatusCombo status={status} />}
                content={descriptionForTaskRunStatus(status)}
              />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Status icons" description="TaskRunStatusIcon at list-row size.">
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-grid-dimmed p-3">
          {allTaskRunStatuses.map((status) => (
            <SimpleTooltip
              key={status}
              button={<TaskRunStatusIcon status={status} className="size-5" />}
              content={status}
            />
          ))}
        </div>
      </StorySection>

      <StorySection
        title="Run icons"
        description="RunIcon — every named icon used in traces and run lists."
      >
        <StoryGrid min="11rem">
          {RUN_ICON_NAMES.map((name) => (
            <Story key={name} label={name}>
              <RunIcon name={name} spanName="storybook" className="size-5" />
            </Story>
          ))}
          <Story label="unknown → fallback">
            <RunIcon name="not-a-real-icon" spanName="storybook" className="size-5" />
          </Story>
          <Story label='spanName "prisma:query"'>
            <RunIcon name={undefined} spanName="prisma:query" className="size-5" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="Run tags"
        description="RunTag — plain and key:value tags; hover for the copy affordance."
      >
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-grid-dimmed p-3">
          {SAMPLE_TAGS.map((tag) => (
            <RunTag key={tag} tag={tag} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-grid-dimmed p-3">
          <RunTag tag="deletable:hover-me" action={{ type: "delete", onDelete: () => {} }} />
          <RunTag tag="linked:tag" to="/storybook/run-statuses" tooltip="Filter by this tag" />
        </div>
      </StorySection>
    </StoryPage>
  );
}
