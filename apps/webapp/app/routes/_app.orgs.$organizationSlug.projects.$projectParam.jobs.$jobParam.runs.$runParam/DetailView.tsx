import { Event, Task } from "~/presenters/RunPresenter.server";
import {
  RunPanel,
  RunPanelBody,
  RunPanelElements,
  RunPanelHeader,
  RunPanelIconElement,
  RunPanelIconSection,
  RunPanelIconTitle,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { cn } from "~/utils/cn";
import {
  formatDateTime,
  formatDuration,
  formatDurationMilliseconds,
} from "~/utils";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Header3 } from "~/components/primitives/Headers";
import { CodeBlock } from "~/components/code/CodeBlock";

type DetailProps =
  | {
      type: "task";
      task: Task;
    }
  | {
      type: "event";
      event: Event;
    };

export function Detail(props: DetailProps) {
  switch (props.type) {
    case "task":
      return <TaskDetail {...props.task} />;
    case "event":
      return <EventDetail {...props.event} />;
  }

  return <></>;
}

export function TaskDetail({
  name,
  icon,
  startedAt,
  completedAt,
  status,
  delayUntil,
  params,
  elements,
  output,
}: Task) {
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
            {formatDuration(startedAt, completedAt, {
              style: "short",
            })}
          </Paragraph>
        }
      />
      <RunPanelBody>
        <div className="mb-4 border-b border-slate-800 pb-4">
          <RunPanelIconSection>
            {startedAt && (
              <RunPanelIconElement
                icon="calendar"
                label="Started at"
                value={formatDateTime(startedAt)}
              />
            )}
            {completedAt && (
              <RunPanelIconElement
                icon="flag"
                label="Finished at"
                value={formatDateTime(completedAt)}
              />
            )}
            {delayUntil && (
              <RunPanelIconElement
                icon="clock"
                label="Total delay"
                value={formatDuration(startedAt, completedAt, {
                  style: "long",
                })}
              />
            )}
          </RunPanelIconSection>
        </div>
        {elements.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            <Header3>Elements</Header3>
            <RunPanelElements
              elements={elements.map((element) => ({
                label: element.label,
                value: element.text,
              }))}
              layout="vertical"
            />
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Header3>Input</Header3>
          <CodeBlock code={JSON.stringify(params, null, 2)} />
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

export function EventDetail({}: Event) {
  return (
    <RunPanel selected={false}>
      <RunPanelHeader icon={undefined} title={""} />
    </RunPanel>
  );
}
