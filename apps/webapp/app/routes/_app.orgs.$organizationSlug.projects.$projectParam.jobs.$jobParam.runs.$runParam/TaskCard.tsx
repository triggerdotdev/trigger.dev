import { Paragraph } from "~/components/primitives/Paragraph";
import { Task } from "~/presenters/RunPresenter.server";
import { formatDateTime, formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDescription,
  RunPanelProperties,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelIconTitle,
  TaskSeparator,
  UpdatingDuration,
  UpdatingDelay,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { Fragment, useState } from "react";
import simplur from "simplur";
import { ChevronDownIcon, Square2StackIcon } from "@heroicons/react/24/solid";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { AnimatePresence, motion } from "framer-motion";
import { delay } from "lodash";

type TaskCardProps = Task & {
  selectedId?: string;
  selectedTask: (id: string) => void;
  isLast: boolean;
  depth: number;
};

export function TaskCard({
  selectedId,
  selectedTask,
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
  properties,
  subtasks,
  error,
  delayUntil,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = id === selectedId;

  return (
    <Fragment>
      <div style={{ marginLeft: `${depth}rem` }}>
        <RunPanel
          selected={isSelected}
          onClick={() => selectedTask(id)}
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
                <UpdatingDuration
                  start={startedAt ?? undefined}
                  end={completedAt ?? undefined}
                />
              </Paragraph>
            }
            styleName={style?.style}
          />
          <RunPanelBody>
            {error && (
              <RunPanelError text={error.message} stackTrace={error.stack} />
            )}
            {description && (
              <RunPanelDescription
                text={description}
                variant={style?.variant}
              />
            )}
            <RunPanelIconSection>
              {displayKey && (
                <RunPanelIconProperty
                  icon="key"
                  label="Key"
                  value={displayKey}
                />
              )}
              {delayUntil && !completedAt && (
                <>
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
              {connection && (
                <RunPanelIconProperty
                  icon={connection.apiConnection.client.integrationIdentifier}
                  label="Connection"
                  value={connection.apiConnection.client.title}
                />
              )}
            </RunPanelIconSection>
            {properties.length > 0 && (
              <RunPanelProperties properties={properties} className="mt-4" />
            )}
          </RunPanelBody>
          {subtasks && subtasks.length > 0 && (
            <button
              className="mt-4 flex h-10 w-full items-center justify-between gap-2 bg-slate-800 px-2"
              onClick={() => setExpanded((c) => !c)}
            >
              <div className="flex items-center gap-2">
                <Square2StackIcon className="h-5 w-5 text-slate-400" />
                <Paragraph variant="small">
                  {simplur`${expanded ? "Hide" : "Show"} ${
                    subtasks.length
                  } subtask[|s]`}
                </Paragraph>
              </div>
              <motion.span
                initial={expanded ? "expanded" : "collapsed"}
                animate={expanded ? "expanded" : "collapsed"}
                variants={{
                  collapsed: { rotate: 0, transition: { ease: "anticipate" } },
                  expanded: { rotate: 180, transition: { ease: "anticipate" } },
                }}
              >
                <ChevronDownIcon
                  className={"h-5 w-5 text-slate-400 transition"}
                />
              </motion.span>
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
          <AnimatePresence key={subtask.id}>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 100 }}>
              <TaskCard
                selectedId={selectedId}
                selectedTask={selectedTask}
                isLast={index === subtasks.length - 1}
                depth={depth + 1}
                {...subtask}
              />
            </motion.div>
          </AnimatePresence>
        ))}
    </Fragment>
  );
}
