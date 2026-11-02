import { useState } from "react";
import { SAMPLES } from "../shared/catalog";
import type { Job } from "../shared/types";
import { workflowPhase } from "./workflow";

const TERMINAL = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "crashed",
  "expired",
  "timed_out",
  "system_failure",
]);
export function jobFinished(job: Job) {
  return !!job.results.length || TERMINAL.has(job.status.toLowerCase());
}

export function JobPanel({
  job,
  pending,
  preview,
  onLoad,
  realtimeProgress,
  realtimePhase,
  realtimeStatus,
  realtimeCompleted = false,
  realtimeIssue = false,
}: {
  job?: Job;
  sessionToken?: string;
  pending: boolean;
  preview: boolean;
  onLoad: (job: Job) => Promise<void>;
  realtimeProgress?: number;
  realtimePhase?: ReturnType<typeof workflowPhase>;
  realtimeStatus?: string;
  realtimeCompleted?: boolean;
  realtimeIssue?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const image = job?.results.find((result) => result.kind === "hero") ?? job?.results[0];
  const local = image?.url.startsWith("blob:");
  const source = SAMPLES.find((sample) => sample.id === job?.sample);
  const failed =
    !!job && jobFinished(job) && !job.results.length && job.status.toLowerCase() !== "completed";
  const displayStatus = realtimeStatus ?? job?.status ?? "";
  const queued =
    !!job &&
    [
      "pending",
      "queued",
      "enqueued",
      "dequeued",
      "delayed",
      "reserved",
      "pending_version",
      "waiting_for_deploy",
    ].includes(displayStatus.toLowerCase());
  const active = !!job && !jobFinished(job);
  const progress = job
    ? Math.min(job.results.length ? 100 : 95, Math.max(job.progress, realtimeProgress ?? 0))
    : 0;
  const phase = realtimePhase ?? workflowPhase(progress, !!job?.results.length);
  const message = pending
    ? "Sending your edit to Convex…"
    : failed
      ? "This edit could not be completed."
      : image
        ? "Loading your edited image…"
        : realtimeCompleted
          ? "Checking your image with Convex…"
          : queued
            ? "Your edit is queued on Trigger.dev."
            : active
              ? phase === "prepare"
                ? "Trigger.dev is preparing your image."
                : phase === "edit"
                  ? "Trigger.dev is applying your edit."
                  : "Trigger.dev is finishing your image."
              : job
                ? "Your image is being checked before delivery."
                : preview
                  ? "Connect Convex to try an edit."
                  : "Your edited image will appear here.";

  return (
    <section
      className="step result-step"
      id="result"
      aria-labelledby="result-title"
      aria-busy={pending || active}
    >
      <h2 id="result-title">3. Your image</h2>
      {local && image && failedUrl !== image.url ? (
        <>
          <img
            className="edited-image"
            src={image.url}
            alt={`Edited ${source?.name ?? "photograph"}`}
            onError={() => setFailedUrl(image.url)}
          />
          <div className="image-actions">
            <a className="download-button" href={image.url} download={`${job!.sample}-edited.avif`}>
              Download image
            </a>
          </div>
        </>
      ) : (
        <div className="result-placeholder" role="status">
          <p>
            {local
              ? "The image preview could not be displayed. You can still download it."
              : message}
          </p>
          {job && !failed && !image && (
            <div className="workflow-progress" aria-label={`Image editing progress: ${phase}`}>
              <progress max={100} value={progress} />
              <ol>
                {(["Prepare", "Edit", "Finish"] as const).map((label, index) => {
                  const phases = ["prepare", "edit", "finish"];
                  const current = phase === phases[index];
                  const complete = phases.indexOf(phase) > index || phase === "ready";
                  return (
                    <li
                      key={label}
                      className={current ? "current" : complete ? "complete" : ""}
                      aria-current={current ? "step" : undefined}
                    >
                      {label}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {active && realtimeIssue && (
            <span className="muted">Live updates unavailable; showing saved progress.</span>
          )}
          {active && (
            <p className="muted">
              The job continues in the background, even if you close this tab.
            </p>
          )}
          {image && !local && (
            <button type="button" className="text-button" onClick={() => void onLoad(job!)}>
              Load image
            </button>
          )}
          {local && image && (
            <a href={image.url} download={`${job!.sample}-edited.avif`}>
              Download image
            </a>
          )}
          {failed && (
            <p className="error" role="alert">
              {job.error ?? "Please try again."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
