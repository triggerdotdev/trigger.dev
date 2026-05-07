"use client";

import { useRealtimeRun, useInputStreamSend } from "@trigger.dev/react-hooks";
import type { approvalTask } from "@/trigger/approval";

export function ApprovalFlow({
  runId,
  accessToken,
}: {
  runId: string;
  accessToken: string;
}) {
  const { run, error: runError } = useRealtimeRun<typeof approvalTask>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });
  const {
    send,
    isLoading: isSending,
    error: sendError,
  } = useInputStreamSend<{ approved: boolean; reviewer: string }>("approval", runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const status = run?.metadata?.status as string | undefined;
  const reviewer = run?.metadata?.reviewer as string | undefined;
  const isWaiting = status === "waiting-for-approval";
  const isCompleted = run?.status === "COMPLETED";
  const isFailed = run?.status === "FAILED" || run?.status === "CANCELED";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div
          className={`w-3 h-3 rounded-full ${
            isWaiting
              ? "bg-yellow-400 animate-pulse"
              : status === "approved"
                ? "bg-green-400"
                : status === "rejected"
                  ? "bg-red-400"
                  : status === "timed-out"
                    ? "bg-gray-400"
                    : "bg-blue-400 animate-pulse"
          }`}
        />
        <span className="text-sm text-gray-600">
          {!run
            ? "Loading..."
            : isWaiting
              ? "Waiting for approval"
              : status === "approved"
                ? `Approved by ${reviewer}`
                : status === "rejected"
                  ? `Rejected by ${reviewer}`
                  : status === "timed-out"
                    ? "Timed out"
                    : `Status: ${run?.status ?? "unknown"}`}
        </span>
      </div>

      {isWaiting && (
        <div className="flex gap-3">
          <button
            onClick={() => send({ approved: true, reviewer: "You" })}
            disabled={isSending}
            className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors font-medium"
          >
            {isSending ? "Sending..." : "Approve"}
          </button>
          <button
            onClick={() => send({ approved: false, reviewer: "You" })}
            disabled={isSending}
            className="px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors font-medium"
          >
            {isSending ? "Sending..." : "Reject"}
          </button>
        </div>
      )}

      {runError && <p className="text-red-500 text-sm">Run error: {runError.message}</p>}
      {sendError && <p className="text-red-500 text-sm">Send error: {sendError.message}</p>}

      {(isCompleted || isFailed) && run?.output && (
        <pre className="bg-gray-100 p-4 rounded-lg text-sm overflow-auto">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      )}
    </div>
  );
}
