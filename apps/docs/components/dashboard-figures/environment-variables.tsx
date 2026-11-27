// The Environment variables page. Copied from the rendered dashboard; the hovered row (Edit and
// Delete buttons, copy-key button) is drawn from source. The webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts.
import { ChevronDown, ClipboardIcon } from "lucide-react";
import {
  AppFrame,
  Button,
  EnvCombo,
  envs,
  PageHeader,
  ShortcutKey,
  SideMenu,
  tableHeader,
  th,
  type Env,
} from "./chrome";
import * as I from "./icons";

/** One value of a key: its environment, a preview branch's name, and whether it's a secret. */
type Value = { env: Env; branch?: string; secret?: boolean };
type Key = { key: string; values: Value[] };

const rows: Key[] = [
  { key: "APP_URL", values: [{ env: "dev" }, { env: "prod" }] },
  { key: "DATABASE_URL", values: [{ env: "dev" }, { env: "prod" }] },
  { key: "STRIPE_SECRET_KEY", values: [{ env: "dev" }, { env: "prod" }] },
];

// The list filtered to Preview with All branches: the Preview values and each branch's own.
const previewRows: Key[] = [
  {
    key: "DATABASE_URL",
    values: [{ env: "preview" }, { env: "preview", branch: "feature/agents" }],
  },
  {
    key: "OPENAI_API_KEY",
    values: [
      { env: "preview", secret: true },
      { env: "preview", branch: "feature/agents", secret: true },
    ],
  },
  { key: "STRIPE_WEBHOOK_URL", values: [{ env: "preview", branch: "fix/checkout" }] },
];

const UPDATED = "17 Nov 2026, 12:22 pm";
const SECURE_MASK = "••••••••••••••••";

function Filter({ env, selected }: { env?: Env; selected?: boolean }) {
  const e = env && envs[env];
  return (
    <div
      className={`relative flex h-full grow text-center font-normal ${selected ? "text-text-bright" : "text-text-dimmed"}`}
    >
      <div className="relative flex h-full w-full items-center justify-between px-2 text-xs">
        <div className="z-10 flex h-full w-full items-center justify-center">
          {e ? (
            <span className="flex items-center gap-1">
              <e.icon className={`${e.text} size-3.5 shrink-0`} />
              <span className={e.text}>{e.short}</span>
            </span>
          ) : (
            <span>All</span>
          )}
        </div>
        {selected && (
          <div className="absolute inset-0 rounded bg-white border border-grid-bright dark:bg-background-raised dark:border-border-bright" />
        )}
      </div>
    </div>
  );
}

function Toolbar({ preview }: { preview?: boolean }) {
  const filters: Env[] = preview ? ["dev", "staging", "preview", "prod"] : ["dev", "prod"];
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
      <div className="flex items-center gap-1">
        <div className="relative h-6 min-w-52">
          <div className="flex items-center px-1 h-6 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full">
            <div className="flex items-center">
              <I.SearchIcon className="size-4 text-text-bright" />
            </div>
            <div className="grow h-full w-full px-1 rounded text-xs leading-6 text-text-dimmed">
              Search 3 keys…
            </div>
            <div className="pr-0.5">
              <ShortcutKey k="/" className="ml-1 -mr-0.5 border-text-dimmed/40 text-text-dimmed" />
            </div>
          </div>
        </div>
      </div>
      <div className="flex rounded text-text-bright h-6 bg-segmented-track w-fit">
        <div className="flex h-full w-full items-center justify-between gap-x-0.5">
          <Filter selected={!preview} />
          {filters.map((env) => (
            <Filter key={env} env={env} selected={preview && env === "preview"} />
          ))}
        </div>
      </div>
      {/* The branch picker: a Select, variant secondary/small, shown on the Preview filter. */}
      {preview && (
        <div
          data-mark="branches"
          className="group flex items-center gap-1 h-6 rounded text-xs px-2 bg-secondary border border-border-bright/50 shadow-xs text-text-bright w-fit min-w-40"
        >
          <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
            <div className="min-w-0 truncate">All branches</div>
          </div>
          <ChevronDown className="size-4 flex-none text-text-dimmed" />
        </div>
      )}
      <div className="ml-auto flex items-center justify-end gap-1.5 pl-0.5">
        <div className="flex items-center h-6 gap-x-1.5 rounded pr-1 py-[0.1rem] pl-1.5 text-text-dimmed border border-border-bright/50 shadow-xs bg-secondary">
          <span className="whitespace-nowrap text-xs text-text-bright">Reveal values</span>
          <div className="inline-flex shrink-0 items-center rounded-full border-2 border-transparent h-3 w-5.5 bg-surface-control-hover">
            <span className="h-2.5 w-2.5 block rounded-full bg-white dark:bg-charcoal-200" />
          </div>
        </div>
        <Button icon={I.CompareIcon}>Compare</Button>
        <Button icon={I.ExclamationCircleIcon}>
          Needs attention
          <span className="ml-1 tabular-nums text-text-dimmed">{preview ? 1 : 3}</span>
        </Button>
        <Button variant="primary" icon={I.PlusIcon} shortcut="n" mark="add-new" markBadge="below">
          Add new
        </Button>
      </div>
    </div>
  );
}

const linkCell =
  "flex w-full whitespace-nowrap items-center text-text-dimmed px-3 py-3 text-xs justify-start text-left";
const bordered =
  "relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright";

/** An icon-only Button, variant "small-menu-item", fullWidth and textAlignLeft. */
function IconMenuButton({
  icon: Icon,
  iconClassName = "",
  className = "",
}: {
  icon: (p: { className?: string }) => React.ReactNode;
  iconClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex font-normal text-center font-sans justify-center items-center shrink-0 h-[1.8rem] px-[0.4rem] text-2sm rounded-sm text-text-dimmed bg-transparent ${className}`}
    >
      <div className="relative flex w-full items-center">
        <div className="text-left flex w-full items-center text-text-bright gap-x-1.5">
          <Icon className={`h-[1.125rem] ${iconClassName} shrink-0 justify-start`} />
        </div>
      </div>
    </div>
  );
}

function Row({
  name,
  value: { env, branch, secret },
  first,
  last,
  hovered = false,
}: {
  name: string;
  value: Value;
  first: boolean;
  last: boolean;
  /** Draw the row hovered: brighter cells, the copy-key button and the Edit and Delete buttons. */
  hovered?: boolean;
}) {
  const border = last ? "" : bordered;
  // Table.tsx "dimmed" variant, group-hover/table-row.
  const cellText = hovered ? "text-text-bright bg-background-bright" : "text-text-dimmed";
  const link = hovered ? linkCell.replace("text-text-dimmed", "text-text-bright") : linkCell;
  return (
    <div
      className={`table-row relative w-full after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px ${last ? "after:bg-surface-control" : "after:bg-transparent"}`}
    >
      <div className={`table-cell align-middle text-xs ${cellText} py-3 w-0 pl-3 pr-0`}>
        <div className="mt-1 size-4 rounded-sm border border-border-bright bg-transparent" />
      </div>
      <div className={`table-cell align-middle text-xs ${cellText}`}>
        <div className={`${link} relative gap-2`}>
          <span className="inline-flex items-center gap-2 font-mono">{first ? name : null}</span>
          {/* CopyKeyButton: on a key's first row, invisible until the row is hovered. */}
          {first && (
            <span className="relative z-10 flex items-center">
              <span
                className={`flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover text-text-dimmed ${hovered ? "" : "opacity-0"}`}
              >
                <ClipboardIcon className="size-3.5" />
              </span>
            </span>
          )}
        </div>
      </div>
      <div className={`table-cell align-middle text-xs ${cellText} py-2 ${border} after:left-3`}>
        <div className="relative w-full">
          {secret ? (
            <div className="flex items-center gap-x-1">
              <I.LockClosedIcon className="size-3 text-text-dimmed" />
              <span className="text-xs text-text-dimmed">Secret</span>
            </div>
          ) : (
            <span className="flex items-center text-text-dimmed font-mono rounded border border-border-bright/50 shadow-xs bg-input-bg text-xs w-full">
              <span className="shrink grow w-full min-w-0 bg-transparent border-0 text-xs px-2 rounded-l h-6 leading-6">
                {SECURE_MASK}
              </span>
              <span className="flex size-6 shrink-0 items-center justify-center rounded border border-border-bright bg-background-hover text-text-dimmed rounded-l-none border-l border-grid-dimmed">
                <ClipboardIcon className="size-3.5" />
              </span>
            </span>
          )}
        </div>
      </div>
      <div className={`table-cell align-middle text-xs ${cellText} ${border}`}>
        <div className={link}>
          {branch ? (
            <span className="flex items-center gap-1.5 text-sm text-text-bright">
              <I.PreviewBranchesIcon className="size-4.5 shrink-0 text-preview" />
              <span className="truncate text-left text-preview">{branch}</span>
            </span>
          ) : (
            <EnvCombo env={env} className="text-sm" />
          )}
        </div>
      </div>
      <div className={`table-cell align-middle text-xs ${cellText} ${border}`}>
        <div className={link}>
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-sm tabular-nums text-text-dimmed">{UPDATED}</span>
          </div>
        </div>
      </div>
      {/* TableCellMenu (sticky) with hiddenButtons: Edit and Delete show while the row is hovered. */}
      <div
        className={`table-cell align-middle text-xs text-right sticky right-0 w-auto ${hovered ? "text-text-bright bg-background-bright z-10" : "text-text-dimmed bg-background-dimmed"}`}
      >
        <div className="relative h-full p-1">
          {hovered && (
            <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 ring-1 bg-background-bright ring-grid-bright">
              <div className="block">
                <div className="flex items-center gap-x-0.5 divide-x divide-grid-bright">
                  <div data-mark="edit" data-mark-badge="below" className="w-full">
                    <IconMenuButton icon={I.PencilSquareIcon} />
                  </div>
                  <div data-mark="delete" data-mark-badge="below" className="w-full">
                    <IconMenuButton
                      icon={I.TrashIcon}
                      iconClassName="text-rose-500"
                      className="ml-0.5"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EnvironmentVariables({
  hover,
  preview,
}: {
  hover?: { key: string; env: Env };
  /** Filtered to Preview: the branch picker, and Preview and branch values. */
  preview?: boolean;
}) {
  return (
    <AppFrame menu={<SideMenu active="Environment variables" open={["Security"]} />}>
      <PageHeader title="Environment variables">
        <Button>View history</Button>
        <Button variant="docs" icon={I.BookIcon}>
          Environment variables docs
        </Button>
      </PageHeader>
      <Toolbar preview={preview} />
      <div className="table w-full whitespace-nowrap">
        <div className={tableHeader}>
          <div className="table-row relative w-full">
            <div className={`${th} w-0 pl-3 pr-0`}>
              <div className="mt-1 size-4 rounded-sm border border-border-bright bg-transparent" />
            </div>
            <div className={`${th} w-[25%]`}>Key</div>
            <div className={`${th} w-[37%]`}>Value</div>
            <div className={`${th} w-[15%]`}>
              <span className="flex items-center gap-1">
                Environment
                <I.InformationCircleIcon className="size-4 text-text-dimmed" />
              </span>
            </div>
            <div className={`${th} w-[22%]`}>
              <div className="flex items-center gap-1">
                Updated
                <span className="ml-1 flex items-center">
                  <I.ChevronUpDownIcon className="size-4 text-text-dimmed" />
                </span>
              </div>
            </div>
            <div className={`${th} w-0`} />
          </div>
        </div>
        <div className="table-row-group relative">
          {(preview ? previewRows : rows).flatMap((row) =>
            row.values.map((value, i) => (
              <Row
                key={`${row.key}-${value.env}-${value.branch ?? ""}`}
                name={row.key}
                value={value}
                first={i === 0}
                last={i === row.values.length - 1}
                hovered={hover?.key === row.key && hover.env === value.env && !value.branch}
              />
            ))
          )}
        </div>
      </div>
    </AppFrame>
  );
}

export function EnvironmentVariablesFigure() {
  return <EnvironmentVariables />;
}

/** The same page with the pointer over DATABASE_URL in Development, showing Edit and Delete. */
export function EnvironmentVariablesRowActionsFigure() {
  return <EnvironmentVariables hover={{ key: "DATABASE_URL", env: "dev" }} />;
}

/** The page filtered to Preview with All branches: Preview values and each branch's overrides. */
export function EnvironmentVariablesPreviewFigure() {
  return <EnvironmentVariables preview />;
}
