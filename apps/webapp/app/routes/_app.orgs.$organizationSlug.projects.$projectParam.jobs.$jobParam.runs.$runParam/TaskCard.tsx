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
import { Fragment, useState } from "react";
import simplur from "simplur";

type TaskCardProps = Task & {
  selectedId?: string;
  setSelectedId: (id: string) => void;
  isLast: boolean;
  depth: number;
};

export function TaskCard({
  selectedId,
  setSelectedId,
  isLast,
  depth,
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
  subtasks,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = id === selectedId;

  return (
    <Fragment>
      <div style={{ marginLeft: `${depth}rem` }}>
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
              <RunPanelDescription
                text={description}
                variant={style?.variant}
              />
            )}
            <RunPanelIconSection>
              {displayKey && (
                <RunPanelIconElement
                  icon="key"
                  label="Key"
                  value={displayKey}
                />
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
          {subtasks && subtasks.length > 0 && (
            <button
              className="mt-4 flex flex-col gap-2"
              onClick={() => setExpanded((c) => !c)}
            >
              {simplur`${expanded ? "Hide" : "Show"} ${
                subtasks.length
              } subtask[|s]`}
            </button>
          )}
        </RunPanel>
      </div>
      {(!isLast || expanded) && (
        <TaskSeparator depth={depth + (expanded ? 1 : 0)} />
      )}
      {subtasks &&
        subtasks.length > 0 &&
        expanded &&
        subtasks.map((subtask, index) => (
          <TaskCard
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            isLast={index === subtasks.length - 1}
            key={index}
            depth={depth + 1}
            {...subtask}
          />
        ))}
    </Fragment>
  );
}
