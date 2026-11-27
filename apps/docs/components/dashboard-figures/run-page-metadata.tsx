// The run page with the inspector on the run's Metadata tab, showing the metadata the run set.
// Drawn from source; the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { RunPageBody } from "./run-page";
import { CodeBlock, RunHeader, RunInspector } from "./run-parts";

export function RunPageMetadataFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunHeader runId="run_cmie3x7k2000107l4hq9s2bxd" />
      <RunPageBody
        inspector={
          <RunInspector task="hello-world" tab="Metadata" tabMark="metadata">
            <div className="flex flex-col gap-4 py-3">
              <CodeBlock value={{ user: { name: "Sam Lee", id: "user_1234" }, progress: 1 }} />
            </div>
          </RunInspector>
        }
      />
    </div>
  );
}
