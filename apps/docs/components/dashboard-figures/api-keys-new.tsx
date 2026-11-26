// The New API key dialog with Access switched to Custom (Operator plus Deploy only), scrolled to
// the Access section as it is at 1440x900. Copied from the rendered dashboard; the webapp files it
// mirrors are its `sources` in lib/dashboard-figures.ts.
import { LockClosedIcon as LockIcon } from "@heroicons/react/20/solid";
import { Button } from "./chrome";
import { DialogClose, Segment } from "./form-parts";
import * as I from "./icons";

/** A segmented control (primitives/SegmentedControl.tsx); the selected segment gets the raised pill. */
function Segmented({
  options,
  selected,
  disabled = [],
  mark,
}: {
  options: string[];
  selected: string;
  disabled?: string[];
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      className="flex rounded text-text-bright h-6 bg-segmented-track w-fit shrink-0"
    >
      <div className="w-full">
        <div className="flex h-full w-full items-center justify-between gap-x-0.5">
          {options.map((o) => (
            <Segment key={o} size="small" selected={o === selected} disabled={disabled.includes(o)}>
              <div>{o}</div>
            </Segment>
          ))}
        </div>
      </div>
    </div>
  );
}

function SelectTrigger({ label, mark }: { label: string; mark: string }) {
  return (
    <div
      data-mark={mark}
      data-mark-badge="below"
      className="group flex h-6 items-center gap-1 rounded pl-2 pr-1 text-text-dimmed border border-grid-bright"
    >
      <div className="font-sans text-xs font-medium text-text-dimmed flex">{label}</div>
      <span className="contents">
        <I.DropdownIcon className="size-4 min-w-4 text-text-dimmed" />
      </span>
    </div>
  );
}

/** One cell of the level grid: no level here ("-"), selectable, selected, or locked by another area. */
type Level = "-" | "off" | "on" | "locked";

const radio =
  "ring-offset-background aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-full border border-border-bright";

function Radio({ level }: { level: Level }) {
  if (level === "-") return <span />;
  return (
    <span className="flex self-stretch justify-center">
      <div className="flex w-full items-center justify-center self-stretch rounded">
        {level === "locked" ? (
          <div className={`${radio} border-dashed bg-transparent opacity-60`} />
        ) : (
          <div className={`${radio} bg-background-raised`}>
            {level === "on" && (
              <div className="flex h-full w-full items-center justify-center border border-indigo-500 bg-indigo-600">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-2 fill-white text-white dark:fill-text-bright dark:text-text-bright"
                >
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
            )}
          </div>
        )}
      </div>
    </span>
  );
}

// Operator + Deploy only, as the dashboard resolves it. Columns: None, Read, Write, Read & write, Manage.
const areas: { name: string; locked?: boolean; levels: Level[] }[] = [
  { name: "Runs", locked: true, levels: ["locked", "locked", "-", "on", "-"] },
  { name: "Batches", levels: ["off", "on", "-", "-", "-"] },
  { name: "Large payloads", levels: ["off", "-", "on", "-", "-"] },
  { name: "Queues", levels: ["off", "off", "-", "on", "-"] },
  { name: "Sessions", levels: ["off", "off", "-", "off", "on"] },
  { name: "Input streams", levels: ["off", "-", "off", "on", "-"] },
  { name: "Tagged runs", levels: ["off", "on", "-", "-", "-"] },
  { name: "Errors", levels: ["off", "off", "-", "on", "-"] },
  { name: "Webhooks", levels: ["off", "off", "-", "on", "-"] },
  { name: "Waitpoints", locked: true, levels: ["locked", "-", "-", "on", "-"] },
  { name: "Prompts", levels: ["off", "on", "-", "off", "-"] },
  { name: "Deployments", levels: ["off", "off", "-", "on", "-"] },
  { name: "Preview branches", levels: ["off", "-", "-", "-", "on"] },
  { name: "Env vars", locked: true, levels: ["locked", "off", "-", "on", "-"] },
];

// The summary beside the grid: each area's level and the scopes it grants (read in blue).
const summary: { area: string; level: string; scopes: string[] }[] = [
  {
    area: "Tasks",
    level: "Read & trigger",
    scopes: ["read:tasks", "trigger:tasks", "batchTrigger:tasks", "batchTrigger:batch"],
  },
  { area: "Runs", level: "Read & write", scopes: ["read:runs", "write:runs"] },
  { area: "Batches", level: "Read", scopes: ["read:batch"] },
  { area: "Large payloads", level: "Write", scopes: ["write:packets"] },
  { area: "Queues", level: "Read & write", scopes: ["read:queues", "write:queues"] },
  {
    area: "Sessions",
    level: "Manage",
    scopes: ["read:sessions", "write:sessions", "admin:sessions"],
  },
  {
    area: "Input streams",
    level: "Read & write",
    scopes: ["read:inputStreams", "write:inputStreams"],
  },
  { area: "Tagged runs", level: "Read", scopes: ["read:tags"] },
  { area: "Errors", level: "Read & write", scopes: ["read:errors", "write:errors"] },
  { area: "Webhooks", level: "Read & write", scopes: ["read:webhooks", "write:webhooks"] },
  { area: "Waitpoints", level: "Read & write", scopes: ["read:waitpoints", "write:waitpoints"] },
  { area: "Prompts", level: "Read", scopes: ["read:prompts"] },
  {
    area: "Deployments",
    level: "Read & write",
    scopes: ["read:deployments", "write:deployments"],
  },
  { area: "Preview branches", level: "Manage", scopes: ["write:branches"] },
  { area: "Env vars", level: "Read & write", scopes: ["read:envvars", "write:envvars"] },
];

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const hint = "font-sans text-xs font-medium text-text-dimmed";
const areaName = "font-sans text-sm font-medium text-text-bright";

function Lock() {
  return (
    <div className="h-fit flex items-center rounded">
      <LockIcon className="size-3 text-text-dimmed" />
    </div>
  );
}

export function ApiKeysNewFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      <div className="relative grid h-full border bg-background-dimmed shadow-lg w-full rounded-lg grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5">
        <div className="absolute left-0 top-11 w-full" />
        <div className="text-left font-medium text-text-bright flex flex-row items-center gap-1.5 px-5 pb-3">
          New API key
          <span className="flex items-center gap-1.5 text-text-bright text-base">
            <I.DevelopmentIcon className="text-dev shrink-0 size-5" />
            <span className="truncate text-left system-mono-label text-dev">Development</span>
          </span>
        </div>
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
          <div className="grid min-h-0 overflow-hidden grid-cols-[minmax(0,1fr)_21rem] border-t border-grid-bright">
            {/* Scrolled down past Name, Expires, Note and Allowed IP addresses to Access. */}
            <div className="min-w-0 px-5 pb-4 pt-5 space-y-5">
              <div className="space-y-1">
                <span className={label}>Access</span>
                <div className="flex items-center justify-between gap-6">
                  <div className={hint}>
                    Use Custom to combine presets and pick the level for each area. It starts from
                    the selected preset, or empty when No restrictions is selected.
                  </div>
                  <Segmented options={["Preset", "Custom"]} selected="Custom" mark="custom" />
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SelectTrigger label="Start from" mark="start-from" />
                    <SelectTrigger label="Add preset" mark="add-preset" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="minimal" mark="clear-all" markBadge="below">
                      Clear all
                    </Button>
                    <Button mark="save-preset" markBadge="below">
                      Save as preset…
                    </Button>
                  </div>
                </div>
                <div className="rounded-md border border-grid-bright">
                  <div className="border-b border-grid-dimmed px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
                      <div className="min-w-48 flex-1">
                        <div className="flex items-center gap-1">
                          <div className={areaName}>Tasks</div>
                          <Lock />
                        </div>
                        <div className={hint}>
                          Operate runs also lets the key cancel and replay their runs.
                        </div>
                      </div>
                      <Segmented
                        options={["None", "Read", "Trigger", "Read & trigger", "Operate runs"]}
                        selected="Read & trigger"
                        disabled={["None", "Read"]}
                        mark="tasks"
                      />
                    </div>
                    <div className="mt-2.5 border-t border-grid-dimmed pt-2.5">
                      <div className="flex items-center gap-4 justify-between">
                        <div className="min-w-0">
                          <div className={areaName}>Task access</div>
                          <div className={hint}>Choose which tasks this key can access.</div>
                        </div>
                        <Segmented
                          options={["All tasks", "Selected tasks"]}
                          selected="All tasks"
                          mark="task-access"
                        />
                      </div>
                    </div>
                  </div>
                  <div
                    data-mark="grid"
                    className="grid gap-x-3 pb-1.5"
                    style={{
                      gridTemplateColumns:
                        "minmax(5.5rem, 9.5rem) repeat(5, minmax(max-content, 1fr))",
                    }}
                  >
                    <div className="col-span-full grid grid-cols-subgrid items-center whitespace-nowrap border-b border-grid-dimmed bg-background-dimmed px-3 py-1.5 text-xs text-text-dimmed">
                      <span>Area</span>
                      {["None", "Read", "Write", "Read & write", "Manage"].map((h) => (
                        <span key={h} className="text-center">
                          {h}
                        </span>
                      ))}
                    </div>
                    {areas.map((a) => (
                      <div
                        key={a.name}
                        className="col-span-full grid grid-cols-subgrid items-center border-b border-grid-dimmed px-3 last:border-b-0"
                      >
                        <div className="min-w-0 py-2">
                          <div className="flex items-center gap-1">
                            <div className={areaName}>{a.name}</div>
                            {a.locked && <Lock />}
                          </div>
                        </div>
                        {a.levels.map((l, i) => (
                          <Radio key={i} level={l} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div data-mark="summary" className="border-l border-grid-bright bg-background-deep">
              <div className="px-5 pb-6 pt-4">
                <div className="space-y-3">
                  <div className="flex flex-col">
                    {summary.map((s) => {
                      const writes = s.scopes.some((c) => !c.startsWith("read:"));
                      return (
                        <div
                          key={s.area}
                          className="border-t border-grid-dimmed py-1.5 first:border-t-0"
                        >
                          <div className="flex items-baseline gap-2.5">
                            <span
                              className={`mt-1.5 size-1.5 shrink-0 rounded-[2px] ${writes ? "bg-amber-500" : "bg-blue-500"}`}
                            />
                            <span className="min-w-0 flex-1 text-xs text-text-bright">
                              {s.area}
                            </span>
                            <span className="whitespace-nowrap text-xs text-text-dimmed">
                              {s.level}
                            </span>
                          </div>
                          <div className="ml-4 mt-1 flex flex-col gap-0.5">
                            {s.scopes.map((c) => (
                              <span
                                key={c}
                                className={`break-all font-mono text-xxs leading-relaxed ${c.startsWith("read:") ? "text-blue-400/80" : "text-amber-400/80"}`}
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-grid-bright p-3">
            <Button size="medium">Cancel</Button>
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="primary" size="medium" mark="create" markBadge="left">
                Create API key
              </Button>
            </div>
          </div>
        </div>
        <DialogClose />
      </div>
    </div>
  );
}
