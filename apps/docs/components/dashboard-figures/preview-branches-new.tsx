// The New branch dialog on the Preview branches page. Copied from the rendered dashboard; the
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { Button } from "./chrome";
import { DialogFrame, FormButtons } from "./form-parts";

// The characters a branch name must not contain, as the dialog lists them.
const forbidden = ["~", "^", ":", "?", "*", "[", "\\", "//", "..", "@{", ".lock"];

export function PreviewBranchesNewFigure() {
  return (
    <DialogFrame title="New branch">
      <div className="mt-2 flex flex-col gap-4">
        <div className="w-full">
          <div className="flex flex-col max-w-full gap-y-3">
            <div className="grid w-full items-center gap-1.5 max-w-full">
              <span className="font-sans text-sm text-text-bright leading-tight flex items-center gap-1">
                Branch name
              </span>
              <div
                data-mark="branch-name"
                className="flex items-center px-1 h-8 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full"
              >
                <div className="grow h-full w-full bg-transparent px-1.5 rounded text-sm" />
              </div>
              <div className="font-sans text-xs font-medium text-text-dimmed">
                Must not contain: spaces{" "}
                {forbidden.map((c, i) => (
                  <span key={c}>
                    {i > 0 && " "}
                    <span className="px-1 py-0.5 rounded border border-grid-bright bg-background-bright text-text-bright font-mono text-wrap text-xs">
                      {c}
                    </span>
                  </span>
                ))}
              </div>
            </div>
            <FormButtons
              cancel={
                <Button variant="tertiary" size="medium">
                  Cancel
                </Button>
              }
              confirm={
                <Button variant="primary" size="medium" mark="create" markBadge="below">
                  Create branch
                </Button>
              }
            />
          </div>
        </div>
      </div>
    </DialogFrame>
  );
}
