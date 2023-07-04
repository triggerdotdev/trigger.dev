import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CodeBlock } from "~/components/code/CodeBlock";
import { DateTime, formattedDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TaskDetailsPresenter } from "~/presenters/TaskDetailsPresenter.server";
import { sensitiveDataReplacer } from "~/services/sensitiveDataReplacer";
import { requireUserId } from "~/services/session.server";
import { formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { TaskParamsSchema } from "~/utils/pathBuilder";
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
} from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/RunCard";
import { TaskStatusIcon } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/TaskStatus";
import { TaskAttemptStatusLabel } from "./TaskAttemptStatus";
import { useLocales } from "~/components/primitives/LocaleProvider";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { taskParam } = TaskParamsSchema.parse(params);

  const presenter = new TaskDetailsPresenter();
  const task = await presenter.call({
    userId,
    id: taskParam,
  });

  if (!task) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    task,
  });
};

export default function Page() {
  const { task } = useTypedLoaderData<typeof loader>();
  const locales = useLocales();

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
              value={formattedDateTime(startedAt, locales)}
            />
          )}
          {completedAt && (
            <RunPanelIconProperty
              icon="flag"
              label="Finished at"
              value={formattedDateTime(completedAt, locales)}
            />
          )}
          {delayUntil && !completedAt && (
            <>
              <RunPanelIconProperty
                icon="flag"
                label="Continues at"
                value={formattedDateTime(delayUntil, locales)}
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
            <RunPanelProperties properties={properties} layout="vertical" />
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
