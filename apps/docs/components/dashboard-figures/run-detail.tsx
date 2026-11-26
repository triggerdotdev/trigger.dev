// The run inspector on its Detail tab for a child run with an idempotency key, cropped to the
// panel. Drawn from source; the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { Button } from "./chrome";
import * as I from "./icons";
import { Copyable } from "./detail-parts";
import { LinkValue, Property, RunInspector } from "./run-parts";

export function RunDetailFigure() {
  return (
    <RunInspector task="child-task" tab="Detail">
      <div className="flex flex-col gap-4 py-3">
        <div className="flex flex-col gap-y-3">
          <Property label="Status">
            <span className="flex items-center gap-1">
              <I.CheckCircleIcon className="h-4 w-4 text-success" />
              <span className="system-mono-label text-success">Completed</span>
            </span>
          </Property>
          <Property label="Task">
            <LinkValue>child-task</LinkValue>
          </Property>
          <Property label="Run ID">
            <Copyable mono={false} value="run_cmie4b2x9000307l4f2k8wq1n" />
          </Property>
          <Property label="Root & Parent run">
            <span className="inline-text-link text-text-link group flex flex-wrap items-center gap-x-1 gap-y-0">
              <Copyable mono={false} value="hello-world" />
              <span className="break-all text-text-dimmed">
                <Copyable mono={false} value="run_cmie4b1q7000107l4d9s3hv5c" />
              </span>
            </span>
          </Property>
          <div className="flex flex-col gap-0 text-sm">
            <div className="font-medium text-text-bright">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1" data-mark="idempotency">
                  Idempotency
                  <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                </span>
                <Button variant="minimal" icon={I.ArrowPathIcon} mark="reset" markBadge="left">
                  Reset
                </Button>
              </div>
            </div>
            <div className="text-text-dimmed">
              <div className="flex flex-col gap-0.5">
                <div>
                  <span className="text-text-dimmed">Key: </span>
                  <span className="group relative inline-flex h-6 items-center max-h-5">
                    <span>welcome-email-user_123</span>
                  </span>
                </div>
                <div>
                  <span className="text-text-dimmed">Scope: </span>
                  run
                </div>
                <div>
                  <span className="text-text-dimmed">Expires: </span>
                  Nov 26, 2026, 10:42:07 AM
                </div>
              </div>
            </div>
          </div>
          <Property label="Debounce">–</Property>
          <Property label="Version">
            <span className="group inline-flex items-center gap-1.5 rounded-sm text-left">
              <span className="underline decoration-charcoal-500 decoration-dotted underline-offset-4">
                20261124.3
              </span>
            </span>
          </Property>
          <Property label="External deployment ID">–</Property>
          <Property label="SDK version">4.5.1</Property>
        </div>
      </div>
    </RunInspector>
  );
}
