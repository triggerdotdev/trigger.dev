"use client";

import React, { useTransition } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { Split, Check, X, Clock } from "lucide-react";
import { approveArticleSummary, rejectArticleSummary } from "@/app/actions";
import type { ReviewStatus } from "@/trigger/reviewSummary";
import type { RealtimeRun, AnyTask } from "@trigger.dev/sdk";

export type ReviewNodeData = Node<
  {
    trigger: {
      taskIdentifier: string;
      currentRun?: RealtimeRun<AnyTask>;
    };
  },
  "review"
>;

export const isReviewNode = (node: Node): node is ReviewNodeData => {
  return node.type === "review";
};

function ReviewNode({ data }: NodeProps<ReviewNodeData>) {
  const { currentRun } = data.trigger;
  const waitpointTokenId = currentRun?.metadata?.waitpointTokenId as string | undefined;
  const audioSummaryUrl = currentRun?.metadata?.audioSummaryUrl as string | undefined;
  const reviewStatus = currentRun?.metadata?.reviewStatus as ReviewStatus | undefined;

  const [isReviewActionPending, startReviewActionTransition] = useTransition();

  return (
    <div className="p-2 shadow-md bg-white border-1 border-zinc-200 text-sm relative rounded-lg">
      {reviewStatus === "pending" && (
        <div className="absolute -top-1.5 -right-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-indigo-600">
          <span className="relative flex size-4">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-600 opacity-75"></span>
            <span className="relative size-4 rounded-full bg-indigo-600 flex items-center justify-center">
              <Split className="text-white size-2.5" />
            </span>
          </span>
        </div>
      )}
      <div className="flex flex-col items-start gap-2">
        <span>Review summary</span>
        <audio controls className="h-[30px] w-[170px] mb-1">
          {audioSummaryUrl && <source src={audioSummaryUrl} />}
        </audio>
        {reviewStatus === "approved" && (
          <div className="bg-green-200 text-green-800 px-2 py-1 rounded-sm text-xs font-semibold">
            <Check className="size-4 inline-block" /> Approved
          </div>
        )}
        {reviewStatus === "rejected" && (
          <div className="bg-red-200 text-red-800 px-2 py-1 rounded-sm text-xs font-semibold">
            <X className="size-4 inline-block" /> Rejected
          </div>
        )}
        {reviewStatus === "timeout" && (
          <div className="bg-yellow-200 text-yellow-800 px-2 py-1 rounded-sm text-xs font-semibold">
            <Clock className="size-4 inline-block" /> Timed out
          </div>
        )}
        {(reviewStatus === undefined || reviewStatus === "pending") && (
          <div className="flex items-center gap-2">
            <button
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 transition-colors text-white px-2 py-1 rounded-sm text-xs font-semibold"
              onClick={() =>
                startReviewActionTransition(() => {
                  waitpointTokenId && approveArticleSummary(waitpointTokenId);
                })
              }
              disabled={!waitpointTokenId || reviewStatus !== "pending" || isReviewActionPending}
            >
              Approve
            </button>
            <button
              className="bg-red-700 hover:bg-red-600 disabled:opacity-50 transition-colors text-white px-2 py-1 rounded-sm text-xs font-semibold"
              onClick={() => {
                startReviewActionTransition(() => {
                  waitpointTokenId && rejectArticleSummary(waitpointTokenId);
                });
              }}
              disabled={!waitpointTokenId || reviewStatus !== "pending" || isReviewActionPending}
            >
              Reject
            </button>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} className="!bg-indigo-500" />
      <Handle type="source" position={Position.Right} className="!bg-indigo-500" />
    </div>
  );
}

export default ReviewNode;
