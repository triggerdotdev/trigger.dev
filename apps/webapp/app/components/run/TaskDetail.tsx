import { DetailedTask } from "~/presenters/TaskDetailsPresenter.server";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDescription,
  RunPanelDivider,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelIconTitle,
  RunPanelProperties,
  UpdatingDelay,
  UpdatingDuration,
} from "./RunCard";
import { sensitiveDataReplacer } from "~/services/sensitiveDataReplacer";
import { formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { CodeBlock } from "../code/CodeBlock";
import { DateTime } from "../primitives/DateTime";
import { Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import {
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
  Table,
} from "../primitives/Table";
import { TaskAttemptStatusLabel } from "./TaskAttemptStatus";
import { TaskStatusIcon } from "./TaskStatus";

export function TaskDetail({ task }: { task: DetailedTask }) {
  const {
    name,
    description,
    icon,
    startedAt,
    completedAt,
    status,
    delayUntil,
    params,
    properties,
    output,
    style,
    attempts,
  } = task;

  return (
    <RunPanel selected={false}>
      <RunPanelHeader
        icon={
          <TaskStatusIcon
            status={status}
            minimal={true}
            className={cn("h-5 w-5")}
          />
        }
        title={<RunPanelIconTitle icon={icon} title={name} />}
        accessory={
          <Paragraph variant="extra-small">
            <UpdatingDuration
              start={startedAt ?? undefined}
              end={completedAt ?? undefined}
            />
          </Paragraph>
        }
      />
      <RunPanelBody>
        <RunPanelIconSection>
          {startedAt && (
            <RunPanelIconProperty
              icon="calendar"
              label="Started at"
              value={<DateTime date={startedAt} />}
            />
          )}
          {completedAt && (
            <RunPanelIconProperty
              icon="flag"
              label="Finished at"
              value={<DateTime date={completedAt} />}
            />
          )}
          {delayUntil && !completedAt && (
            <>
              <RunPanelIconProperty
                icon="flag"
                label="Continues at"
                value={<DateTime date={delayUntil} />}
              />
              <UpdatingDelay delayUntil={delayUntil} />
            </>
          )}
          {delayUntil && completedAt && (
            <RunPanelIconProperty
              icon="clock"
              label="Delay duration"
              value={formatDuration(startedAt, delayUntil, {
                style: "long",
                maxDecimalPoints: 0,
              })}
            />
          )}
        </RunPanelIconSection>
        <RunPanelDivider />
        {description && (
          <RunPanelDescription text={description} variant={style?.variant} />
        )}
        {properties.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            <Header3>Properties</Header3>
            <RunPanelProperties properties={properties} layout="horizontal" />
          </div>
        )}

        {attempts.length > 1 && (
          <div className="mt-4 flex flex-col gap-2">
            <Header3>Retries</Header3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Attempt</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Date</TableHeaderCell>
                  <TableHeaderCell>Error</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.number}>
                    <TableCell>{attempt.number}</TableCell>
                    <TableCell>
                      <TaskAttemptStatusLabel status={attempt.status} />
                    </TableCell>
                    <TableCell>
                      <DateTime
                        date={
                          attempt.status === "PENDING" && attempt.runAt
                            ? attempt.runAt
                            : attempt.updatedAt
                        }
                      />
                    </TableCell>
                    <TableCell>{attempt.error}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <Header3>Input</Header3>
          {params ? (
            <CodeBlock
              code={JSON.stringify(params, sensitiveDataReplacer, 2)}
              maxLines={35}
            />
          ) : (
            <Paragraph variant="small">No input</Paragraph>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Header3>Output</Header3>
          {output ? (
            <CodeBlock code={JSON.stringify(output, null, 2)} />
          ) : (
            <Paragraph variant="small">No output</Paragraph>
          )}
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
