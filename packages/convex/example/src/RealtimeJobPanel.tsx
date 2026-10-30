import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { Job } from "../shared/types";
import { JobPanel, jobFinished } from "./JobPanel";
import { progressFromRun, workflowPhase } from "./workflow";

type Credential = {
  accessToken: string;
  baseURL: string;
  expiresAt: number;
  runId: string;
  jobId: string;
  sessionToken: string;
};
type Props = {
  job?: Job;
  pending: boolean;
  preview: boolean;
  sessionToken: string;
  onLoad: (job: Job) => Promise<void>;
};

export function RealtimeJobPanel({ job, pending, preview, sessionToken, onLoad }: Props) {
  const mint = useAction(api.realtime.token);
  const refreshJob = useMutation(api.jobs.refresh);
  const [credential, setCredential] = useState<Credential>();
  const [streamIssue, setStreamIssue] = useState(false);
  const [refreshIssue, setRefreshIssue] = useState(false);
  const attemptedRefreshes = useRef(new Set<string>());

  const canStream =
    !!job?.realtimeEligible && !!job.runId && !job.results.length && !jobFinished(job);
  const identity = canStream ? `${job.id}:${job.runId}:${sessionToken}` : "";
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const jobId = job?.id;

  const mintToken = useCallback(async () => {
    if (!jobId || !identity || identityRef.current !== identity)
      throw new Error("Realtime unavailable");
    const next = await mint({ jobId: jobId as Id<"edits">, sessionToken });
    if (!next) throw new Error("Realtime unavailable");
    if (identityRef.current !== identity) throw new Error("Realtime credential expired");
    setCredential({ ...next, jobId, sessionToken });
    setStreamIssue(false);
    return next.accessToken;
  }, [identity, jobId, mint, sessionToken]);

  useEffect(() => {
    setCredential(undefined);
    setStreamIssue(false);
    setRefreshIssue(false);
    if (!canStream) return;
    let cancelled = false;
    void mintToken().catch(() => {
      if (!cancelled && identityRef.current === identity) setStreamIssue(true);
    });
    return () => {
      cancelled = true;
    };
  }, [canStream, identity, mintToken]);

  const matchingCredential =
    !!credential &&
    credential.jobId === job?.id &&
    credential.runId === job?.runId &&
    credential.sessionToken === sessionToken;
  const enabled = canStream && !!matchingCredential;
  const runId = enabled ? (job?.runId ?? undefined) : undefined;
  const { run, error } = useRealtimeRun(runId, {
    enabled,
    accessToken: matchingCredential ? credential?.accessToken : undefined,
    baseURL: matchingCredential ? credential?.baseURL : undefined,
    refreshAccessToken: mintToken,
  });

  const matchingRun = enabled && run?.id === job?.runId ? run : undefined;
  const realtimeStatus = matchingRun ? String(matchingRun.status).toUpperCase() : undefined;
  const realtimeCompleted =
    !!matchingRun &&
    (matchingRun.isCompleted || ["EXPIRED", "TIMED_OUT"].includes(realtimeStatus ?? ""));

  useEffect(() => {
    if (!job || !matchingRun || !realtimeCompleted) return;
    const key = `${job.id}:${matchingRun.id}`;
    if (attemptedRefreshes.current.has(key)) return;
    attemptedRefreshes.current.add(key);
    void refreshJob({ jobId: job.id as Id<"edits">, sessionToken }).catch(() => {
      setRefreshIssue(true);
    });
  }, [job, matchingRun, realtimeCompleted, refreshJob, sessionToken]);

  const progress = job ? progressFromRun(job, matchingRun) : 0;
  const phase = workflowPhase(progress, !!job?.results.length);
  return (
    <JobPanel
      job={job}
      pending={pending}
      preview={preview}
      onLoad={onLoad}
      realtimeProgress={progress}
      realtimePhase={matchingRun ? phase : undefined}
      realtimeStatus={realtimeStatus}
      realtimeCompleted={realtimeCompleted}
      realtimeIssue={streamIssue || refreshIssue || (enabled && !!error)}
    />
  );
}
