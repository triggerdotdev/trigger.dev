"use client";

import React, { useEffect, useState, useTransition } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { Split, Check, X, Clock } from "lucide-react";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { approveArticleSummary, rejectArticleSummary } from "@/app/actions";
import type { ReviewStatus } from "@/trigger/reviewSummary";

export type ReviewNodeData = Node<
  {
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
  "review"
>;

export const isReviewNode = (node: Node): node is ReviewNodeData => {
  return node.type === "review";
};

function ReviewNode({ id, data }: NodeProps<ReviewNodeData>) {
  const { runs } = useRealtimeRunsWithTag(data.trigger.userTag);
  const { updateNodeData } = useReactFlow<ReviewNodeData>();

  const [waitpointTokenId, setWaitpointTokenId] = useState<string | undefined>(undefined);
  const [audioSummaryUrl, setAudioSummaryUrl] = useState<string | undefined>(undefined);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | undefined>(undefined);
  const [isReviewActionPending, startReviewActionTransition] = useTransition();

  useEffect(() => {
    if (!data.trigger.currentRunTag && data.trigger.currentRunStatus !== undefined) {
      updateNodeData(id, { trigger: { ...data.trigger, currentRunStatus: undefined } });
      setWaitpointTokenId(undefined);
      setAudioSummaryUrl(undefined);
      setReviewStatus(undefined);
      return;
    }

    const run = runs.find(
      (run) =>
        run.tags.includes(data.trigger.currentRunTag as string) &&
        run.taskIdentifier === data.trigger.taskIdentifier
    );
    if (!run) {
      if (data.trigger.currentRunStatus !== undefined) {
        updateNodeData(id, { trigger: { ...data.trigger, currentRunStatus: undefined } });
        setWaitpointTokenId(undefined);
        setAudioSummaryUrl(undefined);
        setReviewStatus(undefined);
      }
      return;
    }
    setWaitpointTokenId(run.metadata?.waitpointTokenId as string);
    setAudioSummaryUrl(run.metadata?.audioSummaryUrl as string);
    setReviewStatus(run.metadata?.reviewStatus as ReviewStatus);
    updateNodeData(id, { trigger: { ...data.trigger, currentRunStatus: run.status } });
  }, [runs, id, updateNodeData]);

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
