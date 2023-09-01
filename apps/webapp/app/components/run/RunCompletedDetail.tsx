import { CodeBlock } from "~/components/code/CodeBlock";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunStatusIcon, RunStatusLabel } from "~/components/runs/RunStatuses";
import { MatchedRun, useRun } from "~/hooks/useRun";
import { formatDuration } from "~/utils";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
} from "./RunCard";

export function RunCompletedDetail({ run }: { run: MatchedRun }) {
  return (
    <RunPanel>
      <RunPanelHeader
        icon={<RunStatusIcon status={run.status} className={"h-5 w-5"} />}
        title={
          <Paragraph variant="small/bright">
            <RunStatusLabel status={run.status} />
          </Paragraph>
        }
      />
      <RunPanelBody>
        <RunPanelIconSection>
          {run.startedAt && (
            <RunPanelIconProperty
              icon="calendar"
              label="Started at"
              value={<DateTime date={run.startedAt} />}
            />
          )}
          {run.completedAt && (
            <RunPanelIconProperty
              icon="flag"
              label="Finished at"
              value={<DateTime date={run.completedAt} />}
            />
          )}
          {run.startedAt && run.completedAt && (
            <RunPanelIconProperty
              icon="clock"
              label="Total duration"
              value={formatDuration(run.startedAt, run.completedAt, {
                style: "long",
              })}
            />
          )}
        </RunPanelIconSection>
        <RunPanelDivider />
        {run.error && <RunPanelError text={run.error.message} stackTrace={run.error.stack} />}
        {run.output ? (
          <CodeBlock language="json" code={run.output} maxLines={8} />
        ) : (
          run.output === null && <Paragraph variant="small">This run returned nothing</Paragraph>
        )}
      </RunPanelBody>
    </RunPanel>
  );
}
