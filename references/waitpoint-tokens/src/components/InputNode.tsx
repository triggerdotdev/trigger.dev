"use client";

import React, { useActionState, useEffect } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { triggerArticleWorkflow } from "@/app/actions";

export type InputNodeData = Node<{ trigger: { currentRunTag?: string } }, "input_url">;

export const isInputNode = (node: Node): node is InputNodeData => {
  return node.type === "input_url";
};

function InputNode({ id }: NodeProps<InputNodeData>) {
  const [state, formAction, pending] = useActionState(triggerArticleWorkflow, undefined);
  const { updateNodeData } = useReactFlow<InputNodeData>();

  useEffect(() => {
    if (state) {
      updateNodeData(id, { trigger: { currentRunTag: state.runTag } });
    }
  }, [state, id, updateNodeData]);

  return (
    <div className="p-2 shadow-md rounded-lg bg-white border-1 border-zinc-200 text-sm relative">
      {state?.articleUrl && (
        <span className="block w-full bg-black/80 text-white px-2 py-1 rounded-sm text-xs font-mono overflow-hidden text-ellipsis whitespace-nowrap absolute top-[calc(100%+10px)] inset-x-0">
          {state?.articleUrl}
        </span>
      )}

      <form action={formAction}>
        <div className="w-full flex items-center gap-2">
          <input
            name="articleUrl"
            type="url"
            required
            className="grow border-1 border-zinc-300 rounded-sm p-2"
            placeholder="Enter article URL"
          />
          <button
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors text-white px-4 py-2 rounded-sm font-semibold"
            type="submit"
            disabled={pending}
          >
            Submit ✨
          </button>
        </div>
      </form>

      <Handle type="source" position={Position.Right} className="!bg-indigo-500" />
    </div>
  );
}

export default InputNode;
