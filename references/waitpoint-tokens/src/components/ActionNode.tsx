"use client";

import React, { useEffect } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { Loader2, Check, X, Layers, Asterisk, RefreshCcw } from "lucide-react";
import { Tooltip } from "react-tippy";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { cn } from "@/lib/cn";

export type ActionNodeData = Node<
  {
    label: string;
    icon?: LucideIcon;
    isTerminalAction?: boolean;
    trigger: {
      taskIdentifier: string;
      userTag: string;
      currentRunTag?: string;
      currentRunStatus?:
        | "WAITING_FOR_DEPLOY"
        | "PENDING_VERSION"
        | "QUEUED"
        | "EXECUTING"
        | "REATTEMPTING"
        | "FROZEN"
        | "COMPLETED"
        | "CANCELED"
        | "FAILED"
        | "CRASHED"
        | "INTERRUPTED"
        | "SYSTEM_FAILURE"
        | "DELAYED"
        | "EXPIRED"
        | "TIMED_OUT";
    };
  },
  "action"
>;

export const isActionNode = (node: Node): node is ActionNodeData => {
  return node.type === "action";
};

const triggerStatusToIcon: Record<string, React.ElementType> = {
  QUEUED: Layers,
  EXECUTING: Loader2,
  REATTEMPTING: RefreshCcw,
  COMPLETED: Check,
  FAILED: X,
};

function ActionNode({ id, data }: NodeProps<ActionNodeData>) {
  const { runs } = useRealtimeRunsWithTag(data.trigger.userTag);
  const { updateNodeData } = useReactFlow<ActionNodeData>();

  useEffect(() => {
    if (!data.trigger.currentRunTag && data.trigger.currentRunStatus !== undefined) {
      updateNodeData(id, {
        trigger: { ...data.trigger, currentRunStatus: undefined },
      });
      return;
    }

    const run = runs.find(
      (run) =>
        run.tags.includes(data.trigger.currentRunTag as string) &&
        run.taskIdentifier === data.trigger.taskIdentifier
    );
    if (!run) {
      if (data.trigger.currentRunStatus !== undefined) {
        updateNodeData(id, {
          trigger: { ...data.trigger, currentRunStatus: undefined },
        });
      }
      return;
    }
    updateNodeData(id, {
      trigger: { ...data.trigger, currentRunStatus: run.status },
    });
  }, [runs, id, updateNodeData]);

  return (
    <div className="px-4 py-2 shadow-md rounded-lg bg-white border-1 border-zinc-200 text-sm relative">
      {data.trigger.currentRunStatus && (
        <div
          className={cn(
            "absolute -top-1.5 -right-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-gray-400",
            {
              "bg-blue-400": data.trigger.currentRunStatus === "EXECUTING",
              "bg-yellow-400": data.trigger.currentRunStatus === "REATTEMPTING",
              "bg-emerald-400": data.trigger.currentRunStatus === "COMPLETED",
              "bg-red-400": data.trigger.currentRunStatus === "FAILED",
            }
          )}
        >
          {/* @ts-ignore - there is some weird type issue with react-tippy */}
          <Tooltip
            title={data.trigger.currentRunStatus.toLowerCase()}
            position="right"
            trigger="mouseenter"
            size="small"
          >
            {React.createElement(triggerStatusToIcon[data.trigger.currentRunStatus] ?? Asterisk, {
              className: cn("size-3 text-white", {
                "animate-spin": data.trigger.currentRunStatus === "EXECUTING",
              }),
            })}
          </Tooltip>
        </div>
      )}
      <div className="flex items-center gap-2">
        {data.icon && <data.icon className="text-indigo-500 size-4" />}
        {data.label}
      </div>
      <Handle type="target" position={Position.Left} className="!bg-indigo-500" />
      {!data.isTerminalAction && (
        <Handle type="source" position={Position.Right} className="!bg-indigo-500" />
      )}
    </div>
  );
}

export default ActionNode;
