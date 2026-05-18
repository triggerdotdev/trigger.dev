import { InformationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";

// Surfaced on a run-detail page when the run was accepted into the
// mollifier burst buffer and hasn't been materialised into Postgres yet
// (loader sets `isMollified === true`). The drainer will replay the
// snapshot through `engine.trigger` shortly; this banner explains the
// queued state and points the operator at `batchTrigger` as the
// long-term shape for high-fan-out workloads.
//
// Dismissal is localStorage-only for now — per-org server persistence
// can come in a follow-up. Plan Task 21 leaves this an explicit
// choice; the localStorage path avoids adding a write endpoint on the
// hot-fix critical path.
const DISMISSED_KEY = "mollifier_banner_dismissed";

export function MollifierBanner({ className }: { className?: string }) {
  // Start un-dismissed on the server (no localStorage) and reconcile in
  // useEffect so SSR + first client render agree. If we read
  // localStorage in useState's initialiser the client banner can flash
  // visible-then-hidden when hydration runs.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === "true");
    } catch {
      // Some browsers (private mode, embedded webviews) throw on
      // localStorage access. Treat as un-dismissed; the user can dismiss
      // again next visit without server-side state going stale.
    }
  }, []);

  if (dismissed) return null;

  return (
    <div
      className={cn(
        "flex w-full items-start justify-between gap-2.5 rounded-md border border-blue-400/20 bg-blue-400/10 py-2 pl-2 pr-3 shadow-md backdrop-blur-sm",
        className
      )}
      role="status"
    >
      <div className="flex w-full items-start gap-x-2">
        <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
        <div className="flex flex-col gap-y-1">
          <Paragraph variant="small/bright" className="text-blue-200">
            This run was accepted into the burst buffer.
          </Paragraph>
          <Paragraph variant="small" className="text-blue-200/80">
            Your environment briefly exceeded the trigger-rate ceiling, so the
            run is queued in Redis and will materialise here shortly. For
            high-fan-out workloads consider{" "}
            <a
              href="https://trigger.dev/docs/triggering#batchtrigger"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-blue-100"
            >
              batchTrigger
            </a>{" "}
            instead — it&apos;s designed for the fan-out shape and bypasses the
            burst gate.
          </Paragraph>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISSED_KEY, "true");
          } catch {
            // Same fallback as the read above — silent dismiss.
          }
          setDismissed(true);
        }}
        className="rounded p-0.5 text-blue-300/70 transition hover:bg-blue-400/20 hover:text-blue-200"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
