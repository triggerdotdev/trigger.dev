// The Connect GitHub repository dialog, opened from Connect GitHub repo in the project's Git
// settings. Drawn from source (the reference dashboard has no GitHub app); the webapp files it
// mirrors are its `sources` in lib/dashboard-figures.ts.
import { Button } from "./chrome";
import { DialogFrame, FormButtons, Select } from "./form-parts";

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";

export function GitHubConnectRepoFigure() {
  return (
    <DialogFrame title="Connect GitHub repository">
      <div className="mt-2 flex flex-col gap-4">
        <div className="w-full">
          <div className="font-sans text-base font-medium text-text-dimmed mb-3">
            Choose a GitHub repository to connect to your project.
          </div>
          <div className="flex flex-col max-w-full gap-y-3">
            <div className="grid w-full items-center gap-1.5 max-w-full">
              <span className={label}>Account</span>
              <Select variant="secondary/medium" className="text-text-bright" mark="account">
                acme
              </Select>
            </div>
            <div className="grid w-full items-center gap-1.5 max-w-full">
              <span className={label}>Repository</span>
              <Select variant="secondary/medium" className="text-text-bright" mark="repository">
                hello-world
              </Select>
              <div className="font-sans text-xs font-medium text-text-dimmed">
                Configure repository access in{" "}
                <span
                  data-mark="github"
                  className="inline-text-link text-text-link inline-flex gap-0.5 items-center group"
                >
                  GitHub
                </span>
                .
              </div>
            </div>
            <FormButtons
              cancel={<Button size="medium">Cancel</Button>}
              confirm={
                <Button variant="primary" size="medium" mark="connect" markBadge="below">
                  Connect repository
                </Button>
              }
            />
          </div>
        </div>
      </div>
    </DialogFrame>
  );
}
