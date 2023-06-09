import { CodeBlock } from "~/components/code/CodeBlock";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunStatusIcon, RunStatusLabel } from "~/components/runs/RunStatuses";
import { useRun } from "~/hooks/useRun";
import { formatDateTime, formatDuration } from "~/utils";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/RunCard";

export default function Page() {
  const run = useRun();

  return (
    <RunPanel>
      <RunPanelHeader
        icon={<RunStatusIcon status={run.status} className={"h-5 w-5"} />}
        title={<RunStatusLabel status={run.status} />}
      />
      <RunPanelBody>
        <RunPanelIconSection>
          {run.startedAt && (
            <RunPanelIconProperty
              icon="calendar"
              label="Started at"
              value={formatDateTime(run.startedAt, "long")}
            />
          )}
          {run.completedAt && (
            <RunPanelIconProperty
              icon="flag"
              label="Finished at"
              value={formatDateTime(run.completedAt, "long")}
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
        {run.error && (
          <RunPanelError
            text={run.error.message}
            stackTrace={run.error.stack}
          />
        )}
        {run.output ? (
          <CodeBlock language="json" code={run.output} />
        ) : (
          run.output === null && (
            <Paragraph variant="small">This run returned nothing</Paragraph>
          )
        )}
      </RunPanelBody>
    </RunPanel>
  );
}
