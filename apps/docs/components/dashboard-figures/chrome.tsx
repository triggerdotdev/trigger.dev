// The dashboard's shared chrome for figures: side menu, page header, buttons, environment labels.
// Markup and classes copied from the rendered dashboard (capture.js) and the webapp files listed
// as APP_FRAME in lib/dashboard-figures.ts, which every figure using them stamps.
// A figure is a still frame: hover, focus, transition and cursor classes are dropped, and so is
// overflow-hidden around anything a highlight rings (it would clip the ring).
import { GitBranchIcon, GitCommitIcon } from "lucide-react";
import type { ReactNode } from "react";
import * as I from "./icons";
import { ReaderText } from "./reader-text";

type Icon = (props: { className?: string }) => ReactNode;

// ---- Buttons (primitives/Buttons.tsx: sizes x themes, static classes only) ----

const sizes = {
  small: {
    button: "h-6 px-2.5 text-xs",
    icon: "h-3.5 -mx-1",
    gap: "gap-x-2.5",
    shortcut: "-ml-0.5 -mr-1.5 justify-self-center",
  },
  medium: {
    button: "h-8 px-3 text-sm",
    icon: "h-4 -mx-1",
    gap: "gap-x-2.5",
    shortcut: "-ml-0.5 -mr-1.5 rounded justify-self-center",
  },
};

const themes = {
  primary: {
    disabled: "opacity-50",
    text: "text-white",
    button: "bg-accent-fill border border-lavender-500",
    shortcut: "border-white/40 text-white",
    icon: "text-white",
  },
  secondary: {
    disabled: "opacity-60",
    text: "text-text-bright",
    button: "bg-secondary border border-border-bright/50 shadow-xs",
    shortcut: "border-text-dimmed/40 text-text-dimmed",
    icon: "text-text-bright",
  },
  tertiary: {
    disabled: "opacity-60",
    text: "text-text-bright",
    button: "bg-tertiary",
    shortcut: "border-text-dimmed/40 text-text-dimmed",
    icon: "text-text-bright",
  },
  minimal: {
    disabled: "opacity-50",
    text: "text-text-dimmed",
    button: "bg-transparent",
    shortcut: "border-dimmed/40 text-text-dimmed",
    icon: "text-text-dimmed",
  },
  docs: {
    disabled: "opacity-60",
    text: "text-callout-docs-text/70 dark:text-text-bright",
    button: "bg-secondary border border-border-bright/50 shadow-xs",
    shortcut: "border-text-dimmed/40 text-text-dimmed",
    icon: "text-blue-500",
  },
};

/** primitives/ShortcutKey.tsx: the key hint inside a button. */
export function ShortcutKey({
  k,
  size = "small",
  className = "",
}: {
  k: ReactNode;
  size?: "small" | "medium";
  className?: string;
}) {
  const base =
    size === "small"
      ? "justify-center text-[0.6rem] font-mono font-medium min-w-4 min-h-4 rounded-[2px] tabular-nums px-1 flex items-center gap-x-1 border uppercase"
      : "justify-center min-w-5 min-h-5 text-[0.65rem] font-mono font-medium tabular-nums px-1 flex items-center gap-x-1.5 border uppercase";
  return (
    <span className={`${base} ${className}`}>{typeof k === "string" ? <span>{k}</span> : k}</span>
  );
}

export function Button({
  variant = "secondary",
  size = "small",
  icon: Icon,
  trailingIcon: TrailingIcon,
  iconClassName = "",
  disabled,
  shortcut,
  mark,
  markBadge,
  className = "",
  children,
}: {
  variant?: keyof typeof themes;
  size?: keyof typeof sizes;
  icon?: Icon;
  trailingIcon?: Icon;
  /** Extra classes for the leading icon (the dashboard's leadingIconClassName). */
  iconClassName?: string;
  /** Drawn the way a disabled button looks (dimmed), e.g. Templates with no templates saved. */
  disabled?: boolean;
  /** A key (`n`) or the keys as nodes (`⌘` and the enter icon). */
  shortcut?: ReactNode;
  /** data-mark: an element a page can highlight; markBadge places its badge where there's room. */
  mark?: string;
  markBadge?: "below" | "left";
  className?: string;
  children?: ReactNode;
}) {
  const s = sizes[size];
  const t = themes[variant];
  // The dashboard merges classes with tailwind-merge: an icon margin passed in replaces the size's.
  const icon = iconClassName ? `${s.icon.replace(/-mx-\S+/, "")} ${iconClassName}` : s.icon;
  // ...and an icon color passed in replaces the variant's.
  const iconColor = /(^|\s)text-/.test(iconClassName) ? "" : t.icon;
  return (
    <div
      data-mark={mark}
      data-mark-badge={markBadge}
      className={`flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] ${s.button} ${t.button} ${disabled ? t.disabled : ""} ${className}`}
    >
      <div className="relative flex w-full items-center">
        <div className={`justify-center flex w-full items-center ${t.text} ${s.gap}`}>
          {Icon && <Icon className={`${icon} ${iconColor} shrink-0 justify-start`} />}
          {children !== undefined && (
            <span className="mx-auto grow self-center truncate">{children}</span>
          )}
          {TrailingIcon && <TrailingIcon className={`${s.icon} ${t.icon} shrink-0 justify-end`} />}
          {shortcut && (
            <ShortcutKey k={shortcut} size={size} className={`${s.shortcut} ${t.shortcut}`} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Environments (environments/EnvironmentLabel.tsx) ----

export type Env = "dev" | "staging" | "preview" | "prod";

export const envs: Record<Env, { icon: Icon; text: string; short: string; full: string }> = {
  dev: { icon: I.DevelopmentIcon, text: "text-dev", short: "Dev", full: "Development" },
  staging: { icon: I.StagingIcon, text: "text-staging", short: "Staging", full: "Staging" },
  preview: { icon: I.PreviewIcon, text: "text-preview", short: "Preview", full: "Preview" },
  prod: { icon: I.ProductionIcon, text: "text-prod", short: "Prod", full: "Production" },
};

/** EnvironmentCombo: icon and full name. */
export function EnvCombo({
  env,
  gap = "gap-1.5",
  className = "",
}: {
  env: Env;
  gap?: string;
  className?: string;
}) {
  const e = envs[env];
  return (
    <span className={`flex items-center ${gap} text-sm text-text-bright ${className}`}>
      <e.icon className={`size-4.5 shrink-0 ${e.text}`} />
      <span className={e.text}>{e.full}</span>
    </span>
  );
}

// ---- Page header (primitives/PageHeader.tsx: NavBar + PageTitle) ----

export function PageHeader({
  title,
  crumbs = [],
  detail,
  accessory,
  children,
}: {
  title: string;
  /** Breadcrumb links before the title, e.g. ["Endpoints", "github"]. */
  crumbs?: string[];
  /** DetailPageTitle: the title small and dimmed, as detail pages show it after their crumbs. */
  detail?: boolean;
  /** PageTitle's accessory beside the title, e.g. the Runs page's help tooltip icon. */
  accessory?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid h-10 w-full grid-rows-[auto_1px] bg-background-bright">
      <div className="flex w-full items-center gap-2 pl-3 pr-2">
        <div className="flex flex-1 items-center justify-between">
          <div className="flex items-center gap-1.5">
            {crumbs.map((crumb) => (
              <div key={crumb} className="flex items-center gap-1.5">
                <span className="text-xs text-text-dimmed underline-offset-2">{crumb}</span>
                <I.BreadcrumbIcon className="text-border-bright h-5" />
              </div>
            ))}
            <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright flex items-center gap-1">
              {detail ? (
                <span className="min-w-0 truncate text-xs font-normal leading-4 tracking-normal text-text-dimmed">
                  {title}
                </span>
              ) : (
                title
              )}
            </div>
            {accessory && <span className="ml-px flex items-center">{accessory}</span>}
            <span className="flex -ml-1">
              <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] text-xs bg-transparent aspect-square h-6 p-1">
                <I.StarIcon className="size-4 text-text-dimmed" />
              </div>
            </span>
          </div>
          <div className="flex items-center gap-2">{children}</div>
        </div>
      </div>
      <div className="relative h-px w-full bg-grid-bright" />
    </div>
  );
}

// ---- Side menu (navigation/SideMenu.tsx, sideMenuSections.tsx) ----

type MenuItem = {
  name: string;
  icon: Icon;
  active: string;
  badge?: "New" | "Beta";
  tree?: "mid" | "last";
};

const topItems: MenuItem[] = [
  { name: "Tasks", icon: I.TasksIcon, active: "text-tasks" },
  { name: "Runs", icon: I.RunsIcon, active: "text-runs" },
  { name: "Sessions", icon: I.SessionsIcon, active: "text-sessions" },
  { name: "Webhooks", icon: I.WebhooksIcon, active: "text-webhooks", badge: "Beta" },
];

const sections: { title: string; items: MenuItem[] }[] = [
  {
    title: "AI",
    items: [
      { name: "Prompts", icon: I.PromptsIcon, active: "text-aiPrompts" },
      { name: "Models", icon: I.ModelsIcon, active: "text-models" },
    ],
  },
  {
    title: "Observability",
    items: [
      { name: "Logs", icon: I.LogsIcon, active: "text-logs", badge: "New" },
      { name: "Errors", icon: I.ErrorsIcon, active: "text-errors" },
      { name: "Query", icon: I.QueryIcon, active: "text-query" },
      { name: "Concurrency", icon: I.ConcurrencyIcon, active: "text-queues" },
      { name: "Dashboards", icon: I.DashboardsIcon, active: "text-metrics" },
      { name: "Run metrics", icon: I.TreeConnectorIcon, active: "text-metrics", tree: "mid" },
      { name: "AI metrics", icon: I.TreeConnectorIcon, active: "text-metrics", tree: "last" },
    ],
  },
  {
    title: "Deployments",
    items: [
      { name: "Deploys", icon: I.DeploysIcon, active: "text-deployments" },
      { name: "Preview branches", icon: I.PreviewBranchesIcon, active: "text-previewBranches" },
      { name: "Regions", icon: I.RegionsIcon, active: "text-regions" },
    ],
  },
  {
    title: "Security",
    items: [
      { name: "API keys", icon: I.ApiKeysIcon, active: "text-text-bright" },
      {
        name: "Environment variables",
        icon: I.EnvironmentVariablesIcon,
        active: "text-environmentVariables",
      },
    ],
  },
  {
    title: "Manage",
    items: [
      { name: "Waitpoint tokens", icon: I.WaitpointTokensIcon, active: "text-sky-500" },
      { name: "Batches", icon: I.BatchesIcon, active: "text-batches" },
      { name: "Bulk actions", icon: I.BulkActionsIcon, active: "text-text-bright" },
      { name: "Alerts", icon: I.AlertsIcon, active: "text-text-bright" },
      { name: "Limits", icon: I.LimitsIcon, active: "text-text-bright" },
      { name: "Integrations", icon: I.IntegrationsIcon, active: "text-text-bright" },
    ],
  },
];

function Badge({ kind }: { kind: "New" | "Beta" }) {
  return (
    <div className="ml-1 flex shrink-0 items-center gap-1">
      <div
        className={`grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright whitespace-nowrap ${kind === "Beta" ? "text-blue-500" : "text-success"}`}
      >
        <span>{kind}</span>
      </div>
    </div>
  );
}

function TreeLine({ last }: { last: boolean }) {
  return (
    <svg
      className="overflow-visible size-5 shrink-0 text-border-bright"
      viewBox="0 0 20 20"
      fill="none"
    >
      <line x1="10" y1="-6" x2="10" y2={last ? 10 : 26} stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function SideMenuItem({ item, active }: { item: MenuItem; active: boolean }) {
  return (
    <div
      data-mark={active ? "nav" : undefined}
      className={`block w-full flex h-8 items-center gap-2 rounded pl-1.75 pr-2 ${active ? "bg-tertiary text-text-bright" : "text-text-dimmed"}`}
    >
      {item.tree ? (
        <TreeLine last={item.tree === "last"} />
      ) : (
        <item.icon className={`size-5 shrink-0 ${active ? item.active : "text-text-dimmed"}`} />
      )}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex w-full min-w-0 items-center justify-between">
          <span className="overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left text-[0.90625rem] font-medium tracking-[-0.01em]">
            {item.name}
          </span>
          {item.badge && <Badge kind={item.badge} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The project side menu with `active` selected. Sections other than `open` are drawn collapsed
 * (a state the dashboard remembers per user), which keeps figures short. The active item is mark "nav".
 */
export function SideMenu({
  active,
  open,
  env = "dev",
}: {
  active?: string;
  open: string[];
  /** The selected environment (Development unless a figure says otherwise). */
  env?: Env;
}) {
  const e = envs[env];
  return (
    <div
      className="relative h-full border-r bg-background-bright border-grid-bright"
      style={{ width: 224 }}
    >
      <div className="absolute inset-0 grid grid-cols-[100%] grid-rows-[2.5rem_auto_1fr_auto]">
        <div className="flex min-w-0 items-center overflow-hidden border-b border-transparent px-1 py-1">
          <div className="min-w-0 flex-1">
            <div className="group flex h-8 items-center rounded pl-1.75 w-full justify-between pr-1">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <span className="grid shrink-0 place-items-center overflow-hidden size-5">
                  <span className="relative grid place-items-center overflow-hidden rounded-[10%] font-semibold size-full bg-indigo-500 text-white">
                    <span className="font-bold leading-none text-[0.75rem]">
                      <ReaderText field="org-initials">Ac</ReaderText>
                    </span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                  <span className="overflow-hidden whitespace-nowrap text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                    <ReaderText field="org">Acme</ReaderText>
                  </span>
                </span>
              </span>
            </div>
          </div>
          <div className="group flex size-8 items-center justify-center rounded">
            <I.AccountIcon className="aspect-square text-text-dimmed size-5" />
          </div>
        </div>
        <div className="border-b border-grid-bright pb-2.5 pt-1 px-2.5">
          <div className="w-full space-y-1">
            <div className="flex h-4 items-center justify-between overflow-hidden pl-1.5">
              <div className="text-xs whitespace-nowrap">Project</div>
            </div>
            <div className="space-y-1">
              <div className="group flex h-8 items-center rounded border pl-1.75 justify-between border-grid-bright pr-1 w-full">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <I.FolderIcon className="size-5 shrink-0 text-text-bright" />
                  <span className="overflow-hidden whitespace-nowrap text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                    <ReaderText field="project">hello-world</ReaderText>
                  </span>
                </span>
              </div>
              <div className="group flex h-8 items-center rounded pl-1.75 justify-between pr-1 w-full">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <e.icon className={`${e.text} size-5 shrink-0`} />
                  <span
                    className={`overflow-hidden whitespace-nowrap text-left ${e.text} text-[0.90625rem] font-medium tracking-[-0.01em]`}
                  >
                    {e.full}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
        {/* clip, not hidden: a highlight badge can stick out to the right */}
        <div className="min-h-0 overflow-y-clip overflow-x-visible pt-2.5">
          <div className="mb-6 flex w-full flex-col gap-4 pl-2.5 pr-2">
            <div className="w-full space-y-0">
              {topItems.map((item) => (
                <SideMenuItem key={item.name} item={item} active={item.name === active} />
              ))}
            </div>
            {sections.map((section) => {
              const isOpen = open.includes(section.title);
              return (
                <div key={section.title} className="w-full">
                  <div className="flex w-full items-center justify-between rounded-sm py-1 pl-1.5 pr-1">
                    <div className="flex items-center gap-1 text-text-dimmed">
                      <div className="whitespace-nowrap text-xs">{section.title}</div>
                      <div className={isOpen ? undefined : "-rotate-90"}>
                        <I.ToggleArrowIcon className="size-2" />
                      </div>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="w-full space-y-0">
                      {section.items.map((item) => (
                        <SideMenuItem key={item.name} item={item} active={item.name === active} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          <div className="flex w-full items-center justify-between">
            <div className="flex h-8 items-center gap-1.5 rounded pl-1.75 pr-2">
              <I.QuestionMarkIcon className="size-5 min-w-5 shrink-0 text-success" />
              <span className="whitespace-nowrap text-[0.90625rem] font-medium tracking-[-0.01em] text-text-dimmed">
                Help &amp; Feedback
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The dashboard's app frame: side menu on the left, the page on the right. */
export function AppFrame({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[auto_1fr] bg-background-dimmed">
      {menu}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---- Toolbar controls ----

/** primitives/SearchInput.tsx: the small search field (placeholder showing, not focused). */
export function SearchField({ placeholder, shortcut }: { placeholder: string; shortcut?: string }) {
  return (
    <div className="flex items-center gap-1">
      <div className="relative h-6 min-w-52">
        <div className="flex items-center px-1 h-6 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full">
          <div className="flex items-center">
            <I.SearchIcon className="size-4 text-text-bright" />
          </div>
          <div className="grow h-full w-full px-1 rounded text-xs leading-6 text-text-dimmed">
            {placeholder}
          </div>
          {shortcut && (
            <div className="pr-0.5">
              <ShortcutKey
                k={shortcut}
                className="ml-1 -mr-0.5 border-text-dimmed/40 text-text-dimmed"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** primitives/Switch.tsx, variant "secondary/small": a label and the switch in one bordered box. */
export function SmallSwitch({
  label,
  checked,
  disabled,
  mark,
}: {
  label: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      className={`flex items-center h-6 gap-x-1.5 rounded pr-1 py-[0.1rem] pl-1.5 text-text-dimmed border border-border-bright/50 shadow-xs bg-secondary ${disabled ? "opacity-50" : ""}`}
    >
      <span className="whitespace-nowrap text-xs text-text-bright">{label}</span>
      <div
        className={`inline-flex shrink-0 items-center rounded-full border-2 border-transparent h-3 w-5.5 ${checked ? "bg-accent-fill" : "bg-surface-control-hover"}`}
      >
        <span
          className={`h-2.5 w-2.5 block rounded-full ${checked ? "translate-x-2 bg-white" : "bg-white dark:bg-charcoal-200"}`}
        />
      </div>
    </div>
  );
}

// ---- Table parts (primitives/Table.tsx, "dimmed" variant) ----
// align-middle: a real <td> is vertically centered by default.

export const tableHeader =
  "table-header-group relative bg-background-dimmed after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright";
export const tableRow =
  "table-row relative w-full after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-grid-dimmed";
export const th =
  "table-cell align-middle font-medium text-text-bright px-3 py-2.5 pb-3 text-sm text-left";
export const td = "table-cell align-middle text-xs text-text-dimmed";
/** A TableCell with `to`: the link fills the cell and has the padding. `pad` replaces the default
 * where the table passes an actionClassName (tailwind-merge drops the replaced class). */
const cellLink = (pad = "px-3 py-3") =>
  `flex w-full whitespace-nowrap items-center text-text-dimmed ${pad} text-xs justify-start text-left`;

/** A TableCell with `to`, the commonest cell. `mark` rings the content, not the whole cell. */
export function Cell({
  className,
  pad,
  mark,
  children,
}: {
  className?: string;
  pad?: string;
  mark?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `${td} ${className}` : td}>
      <span className={cellLink(pad)}>
        {mark ? (
          <span data-mark={mark} className="flex">
            {children}
          </span>
        ) : (
          children
        )}
      </span>
    </div>
  );
}

/** The git links in a table cell (components/GitMetadata.tsx): branch, then commit. */
export function GitLinks({ branch, commit }: { branch?: string; commit?: string }) {
  const link = (Icon: Icon, text: string, max: string) => (
    <div className="flex w-fit text-xs font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 pl-1 pr-2.5 bg-transparent">
      <div className="relative flex w-full items-center">
        <div className="justify-center flex w-full items-center text-text-dimmed gap-x-1">
          <Icon className="size-4" />
          <span className={`inline-block ${max} truncate align-bottom`}>{text}</span>
        </div>
      </div>
    </div>
  );
  return (
    <div className="-ml-1 flex items-center">
      {branch && link(GitBranchIcon, branch, "max-w-40")}
      {commit && link(GitCommitIcon, commit, "max-w-64")}
    </div>
  );
}

/** An open row menu (TableCellMenu's popover, primitives/Popover.tsx), anchored to its trigger. */
export function RowMenuPopover({ children, bare }: { children: ReactNode; bare?: boolean }) {
  return (
    <div className="rounded border border-grid-bright bg-background-bright shadow-md min-w-40 max-w-80 p-0">
      {/* A popoverContent render function (bare) gets no padded wrapper around its items. */}
      {bare ? children : <div className="flex flex-col gap-1 p-1">{children}</div>}
    </div>
  );
}

/** A Button with variant "small-menu-item": one row of a row menu. `className` is the item's
 * size after tailwind-merge (default: fullWidth and textAlignLeft, as TableCellMenu passes). */
export function RowMenuItem({
  icon: Icon,
  iconClassName = "",
  className = "h-[1.8rem] text-2sm rounded-sm w-full px-1.5 py-[0.9rem]",
  mark,
  markBadge,
  markInner,
  children,
}: {
  icon: Icon;
  iconClassName?: string;
  className?: string;
  mark?: string;
  markBadge?: "below" | "left";
  /** Outline the button itself rather than its full-width wrapper. */
  markInner?: boolean;
  children: ReactNode;
}) {
  const marked = { "data-mark": mark, "data-mark-badge": markBadge };
  return (
    <div {...(markInner ? {} : marked)} className="w-full">
      <div
        {...(markInner ? marked : {})}
        className={`flex font-normal text-center font-sans justify-center items-center shrink-0 ${className} text-text-dimmed bg-transparent`}
      >
        <div className="relative flex w-full items-center">
          <div className="text-left flex w-full items-center text-text-bright gap-x-1.5">
            <Icon className={`h-[1.125rem] ${iconClassName} shrink-0 justify-start`} />
            <span className="mx-auto grow self-center truncate">{children}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// secondary/small Button classes (chrome.tsx Button), for buttons whose child is an element: the
// dashboard renders an element child as is, without Button's truncating span.
export const secondarySmall =
  "flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 text-xs bg-secondary border border-border-bright/50 shadow-xs";

/** ListPagination with no other page: both buttons disabled. */
export function Pagination() {
  return (
    <div className="flex items-center">
      <div className="order-1">
        <div
          className={`${secondarySmall} items-center rounded-r-none border-r-0 pl-2 pr-2.25 opacity-50`}
        >
          <div className="relative flex w-full items-center">
            <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
              <I.ChevronLeftIcon className="h-3.5 -mx-1 text-text-bright shrink-0 justify-start" />
            </div>
          </div>
        </div>
      </div>
      <div className="order-3">
        <div
          className={`${secondarySmall} items-center rounded-l-none border-l-0 pl-2.25 pr-2 opacity-50`}
        >
          <div className="relative flex w-full items-center">
            <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
              <I.ChevronRightIcon className="h-3.5 -mx-1 text-text-bright shrink-0 justify-end" />
            </div>
          </div>
        </div>
      </div>
      <div className="order-2 h-6 w-px bg-surface-control opacity-30" />
    </div>
  );
}

/** A section heading as the billing settings page draws it (Header2 and a small Paragraph). */
export function SectionHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 border-b border-grid-dimmed pb-3">
      <div className="font-sans text-base leading-6 font-semibold tracking-tight mb-2 text-text-bright">
        {title}
      </div>
      <div className="font-sans text-sm font-medium text-text-dimmed">{children}</div>
    </div>
  );
}
