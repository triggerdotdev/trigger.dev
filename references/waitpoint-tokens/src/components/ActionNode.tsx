"use client";

import React from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { Loader2, Check, X, Layers, Asterisk, RefreshCcw } from "lucide-react";
import { Tooltip } from "react-tippy";
import type { RealtimeRun, AnyTask } from "@trigger.dev/sdk";
import { cn } from "@/lib/cn";

export type ActionNodeData = Node<
  {
    label: string;
    icon?: LucideIcon;
    isTerminalAction?: boolean;
    trigger: {
      taskIdentifier: string;
      currentRun?: RealtimeRun<AnyTask>;
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

function ActionNode({ data }: NodeProps<ActionNodeData>) {
  const { currentRun } = data.trigger;

  return (
    <div className="px-4 py-2 shadow-md rounded-lg bg-white border-1 border-zinc-200 text-sm relative">
      {currentRun && (
        <div
          className={cn(
            "absolute -top-1.5 -right-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-gray-400",
            {
              "bg-blue-400": currentRun.status === "EXECUTING",
              "bg-yellow-400": currentRun.status === "REATTEMPTING",
              "bg-emerald-400": currentRun.status === "COMPLETED",
              "bg-red-400": currentRun.status === "FAILED",
            }
          )}
        >
          {/* @ts-ignore - there is some weird type issue with react-tippy */}
          <Tooltip
            title={currentRun.status.toLowerCase()}
            position="right"
            trigger="mouseenter"
            size="small"
          >
            {React.createElement(triggerStatusToIcon[currentRun.status] ?? Asterisk, {
              className: cn("size-3 text-white", {
                "animate-spin": currentRun.status === "EXECUTING",
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
