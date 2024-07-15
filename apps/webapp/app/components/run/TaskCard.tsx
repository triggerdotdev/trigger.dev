import { ChevronDownIcon, Square2StackIcon } from "@heroicons/react/24/solid";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useState } from "react";
import simplur from "simplur";
import { Paragraph } from "~/components/primitives/Paragraph";
import { type ViewTask } from "~/presenters/RunPresenter.server";
import { cn } from "~/utils/cn";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDescription,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelIconTitle,
  RunPanelProperties,
  TaskSeparator,
  UpdatingDelay,
  UpdatingDuration,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { formatDuration } from "@trigger.dev/core/v3/utils/durations";

type TaskCardProps = ViewTask & {
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
        <RunPanel selected={isSelected} onClick={() => selectedTask(id)} styleName={style?.style}>
          <RunPanelHeader
            icon={
              status === "COMPLETED" ? (
                icon
              ) : (
                <TaskStatusIcon
                  status={status}
                  minimal={true}
                  className={cn("h-5 w-5", !isSelected && "text-charcoal-400")}
                />
              )
            }
            title={status === "COMPLETED" ? name : <RunPanelIconTitle icon={icon} title={name} />}
            accessory={
              <Paragraph variant="extra-small">
                <UpdatingDuration start={startedAt ?? undefined} end={completedAt ?? undefined} />
              </Paragraph>
            }
            styleName={style?.style}
          />
          <RunPanelBody>
            {error && <RunPanelError text={error.message} stackTrace={error.stack} />}
            {description && <RunPanelDescription text={description} variant={style?.variant} />}
            <RunPanelIconSection>
              {displayKey && <RunPanelIconProperty icon="key" label="Key" value={displayKey} />}
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
                  icon={
                    connection.integration.definition.icon ?? connection.integration.definitionId
                  }
                  label="Connection"
                  value={connection.integration.slug}
                />
              )}
            </RunPanelIconSection>
            {properties.length > 0 && (
              <RunPanelProperties properties={properties} className="mt-4" />
            )}
          </RunPanelBody>
          {subtasks && subtasks.length > 0 && (
            <button
              className="mt-4 flex h-10 w-full items-center justify-between gap-2 bg-charcoal-800 px-2"
              onClick={() => setExpanded((c) => !c)}
            >
              <div className="flex items-center gap-2">
                <Square2StackIcon className="h-5 w-5 text-charcoal-400" />
                <Paragraph variant="small">
                  {simplur`${expanded ? "Hide" : "Show"} ${subtasks.length} subtask[|s]`}
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
                <ChevronDownIcon className={"h-5 w-5 text-charcoal-400 transition"} />
              </motion.span>
            </button>
          )}
        </RunPanel>
      </div>
      {(!isLast || expanded) && <TaskSeparator depth={depth + (expanded ? 1 : 0)} />}

      {subtasks &&
        subtasks.length > 0 &&
        expanded &&
        subtasks.map((subtask, index) => (
          <AnimatePresence key={subtask.id}>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 100 }}>
              <TaskCard
                selectedId={selectedId}
                selectedTask={selectedTask}
                isLast={false}
                depth={depth + 1}
                {...subtask}
              />
            </motion.div>
          </AnimatePresence>
        ))}
    </Fragment>
  );
}
