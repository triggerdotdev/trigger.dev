import { Paragraph } from "~/components/primitives/Paragraph";
import { Task } from "~/presenters/RunPresenter.server";
import { formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDescription,
  RunPanelElements,
  RunPanelHeader,
  RunPanelIconElement,
  RunPanelIconSection,
  RunPanelIconTitle,
  TaskSeparator,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { Fragment } from "react";

type TaskCardProps = Task & {
  isSelected: boolean;
  setSelectedId: (id: string) => void;
  isLast: boolean;
};

export function TaskCard({
  isSelected,
  setSelectedId,
  isLast,
  id,
  style,
  status,
  icon,
  name,
  startedAt,
  completedAt,
  description,
  displayKey,
  connection,
  elements,
  children,
}: TaskCardProps) {
  return (
    <Fragment>
      <RunPanel
        selected={isSelected}
        onClick={() => setSelectedId(id)}
        styleName={style?.style}
      >
        <RunPanelHeader
          icon={
            status === "COMPLETED" ? (
              icon
            ) : (
              <TaskStatusIcon
                status={status}
                minimal={true}
                className={cn("h-5 w-5", !isSelected && "text-slate-400")}
              />
            )
          }
          title={
            status === "COMPLETED" ? (
              name
            ) : (
              <RunPanelIconTitle icon={icon} title={name} />
            )
          }
          accessory={
            <Paragraph variant="extra-small">
              {formatDuration(startedAt, completedAt, {
                style: "short",
              })}
            </Paragraph>
          }
          styleName={style?.style}
        />
        <RunPanelBody>
          {description && (
            <RunPanelDescription text={description} variant={style?.variant} />
          )}
          <RunPanelIconSection>
            {displayKey && (
              <RunPanelIconElement icon="key" label="Key" value={displayKey} />
            )}
            {connection && (
              <RunPanelIconElement
                icon={connection.apiConnection.client.integrationIdentifier}
                label="Connection"
                value={connection.apiConnection.client.title}
              />
            )}
          </RunPanelIconSection>
          {elements.length > 0 && (
            <RunPanelElements
              elements={elements.map((element) => ({
                label: element.label,
                value: element.text,
              }))}
              className="mt-4"
            />
          )}
        </RunPanelBody>
      </RunPanel>
      {!isLast && <TaskSeparator />}
    </Fragment>
  );
}
