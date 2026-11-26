// The Billing alerts section of the organization's Billing limits settings page, with a $250.00
// custom limit set (so alerts are percentages of it) and an alert just added (so Update alerts
// shows). Drawn from source: the local dashboard has no billing. The webapp files it mirrors are
// its `sources` in lib/dashboard-figures.ts.
import { Button, SectionHeader } from "./chrome";
import { FormButtons } from "./form-parts";
import * as I from "./icons";

const thresholds = [
  { percent: "50", amount: "$125.00" },
  { percent: "80", amount: "$200.00" },
];

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const input =
  "flex items-center px-1 h-8 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg";
const inputText = "grow h-full bg-transparent px-1.5 rounded text-sm leading-8";

export function BillingAlertsFigure() {
  return (
    <div className="h-full bg-background-dimmed text-text-dimmed px-4 py-6">
      <SectionHeader title="Billing alerts">
        Receive an email when your compute spend crosses different thresholds. You can also learn
        how to{" "}
        <span className="inline-text-link text-text-link inline-flex gap-0.5 items-center">
          reduce your compute spend
        </span>
        .
      </SectionHeader>
      <div className="flex flex-col gap-y-5">
        <div className="space-y-2">
          <div className={label}>Alert me when I reach</div>
          <div data-mark="thresholds" data-mark-badge="below" className="flex flex-col gap-2">
            {thresholds.map((t) => (
              <div key={t.percent} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <div className={`${input} max-w-max`}>
                    <div className={`${inputText} w-24 text-text-bright`}>{t.percent}</div>
                  </div>
                  <span className="text-sm text-text-dimmed">%</span>
                  <span className="text-sm text-text-dimmed">({t.amount})</span>
                  <Button variant="tertiary" icon={I.TrashIcon} className="shrink-0" />
                </div>
              </div>
            ))}
          </div>
          <Button variant="tertiary" icon={I.PlusIcon} className="mt-2 w-fit" mark="add-alert">
            Add alert
          </Button>
        </div>
        <div
          data-mark="emails"
          data-mark-badge="below"
          className="grid w-full items-center gap-1.5 mt-4"
        >
          <div className={label}>Email addresses</div>
          <div className={input}>
            <div className={`${inputText} w-full text-text-bright`}>sam@example.com</div>
          </div>
          <div className={input}>
            <div className={`${inputText} w-full text-text-dimmed`}>Add another email</div>
          </div>
        </div>
        <FormButtons
          confirm={
            <Button variant="primary" mark="update" markBadge="left">
              Update alerts
            </Button>
          }
        />
      </div>
    </div>
  );
}
