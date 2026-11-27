// The project Integrations settings page: the Git settings section with a connected repo (drawn
// from source; the reference dashboard has no GitHub app) and the Build settings section (copied
// from the rendered dashboard). The webapp files they mirror are their `sources` in
// lib/dashboard-figures.ts.
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, envs, type Env } from "./chrome";
import { Switch } from "./form-parts";
import * as I from "./icons";

const rowTitle = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const rowDescription = "font-sans text-xs font-medium text-text-dimmed";
const caps = "font-sans text-xxs uppercase tracking-wider font-medium text-text-dimmed";
const input =
  "flex items-center px-1 h-8 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full";
const inputText = "grow h-full w-full px-1.5 rounded text-sm leading-8 truncate";

/** SettingsContainer: the centered 600px column (37.5rem, p-1) on the page background. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="h-full bg-background-dimmed px-6 pt-6">
      <div className="mx-auto max-w-[37.5rem] p-1">{children}</div>
    </div>
  );
}

function SettingsHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex w-full items-end justify-between gap-8 border-b border-grid-dimmed pb-3">
      <div className="space-y-0.5">
        <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright">
          {title}
        </div>
        {description && (
          <div className="font-sans text-sm font-medium text-text-dimmed">{description}</div>
        )}
      </div>
    </div>
  );
}

/** SettingsRow, size md: title and description on the left, the action on the right. */
function SettingsRow({
  title,
  description,
  action,
  align = "items-center",
  children,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  align?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`flex w-full justify-between gap-8 ${align} py-4 border-b border-grid-dimmed`}>
      {children ?? (
        <div className="flex-1 space-y-0.5">
          {title && <span className={rowTitle}>{title}</span>}
          {description && <div className={rowDescription}>{description}</div>}
        </div>
      )}
      {action && <div className="flex flex-none items-center">{action}</div>}
    </div>
  );
}

/** Switch, variant medium. */
function LabeledSwitch({ checked, label }: { checked: boolean; label?: string }) {
  return (
    <div className="group flex items-center gap-x-2 rounded-md py-1.5 px-2">
      <Switch size="medium" checked={checked} />
      {label && <span className="whitespace-nowrap text-sm text-text-dimmed">{label}</span>}
    </div>
  );
}

function Status({ children }: { children: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-text-dimmed">
      {children}
      <I.CheckCircleIcon className="size-4 text-success" />
    </span>
  );
}

/** A tracking-branch row: EnvironmentRowLabel, then the branch control and Skip superseded. */
function TrackingRow({
  env,
  control,
  supersede,
}: {
  env: Env;
  control: ReactNode;
  supersede: boolean;
}) {
  const e = envs[env];
  return (
    <SettingsRow
      action={
        <div className="flex items-center gap-6">
          <div data-mark={env} className="w-64 shrink-0">
            {control}
          </div>
          <div className="flex w-28 shrink-0 justify-end">
            <LabeledSwitch checked={supersede} />
          </div>
        </div>
      }
    >
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-1.5">
          <e.icon className={`size-4 ${e.text}`} />
          <span className={`text-sm ${e.text}`}>{e.full}</span>
        </div>
      </div>
    </SettingsRow>
  );
}

function BranchInput({ branch }: { branch?: string }) {
  return (
    <div className={input}>
      <div className="pointer-events-none flex items-center">
        <GitBranchIcon className="size-4 ml-0.5 text-text-dimmed" />
      </div>
      <div className={`${inputText} font-mono ${branch ? "text-text-bright" : "text-text-dimmed"}`}>
        {branch ?? "none"}
      </div>
    </div>
  );
}

export function ProjectSettingsGitFigure() {
  return (
    <Page>
      <SettingsHeader title="Git settings" />
      <SettingsRow title="GitHub app" action={<Status>Installed</Status>} />
      <SettingsRow title="GitHub repo" action={<Status>Connected</Status>} />
      <SettingsRow
        description={
          <>
            <span className="mr-2 inline-block size-1.5 rounded-full bg-success align-[0.15em]" />
            Private repo
            <I.OctoKittyIcon className="ml-2 mr-1.5 inline size-3.5 align-text-bottom text-text-bright" />
            <span className="inline-text-link text-text-link inline-flex gap-0.5 items-center group">
              acme/hello-world
            </span>{" "}
            connected on 3 Nov 2026.
          </>
        }
        action={
          <Button mark="disconnect" markBadge="left">
            Disconnect
          </Button>
        }
      />
      <div className="w-full py-3">
        <div className={rowDescription}>
          Pushes to a tracking branch deploy to its environment. With Skip superseded on, older
          queued builds are dropped when a newer commit arrives.
        </div>
      </div>
      <div className="flex gap-6 border-b border-grid-dimmed pb-2">
        <div className={`${caps} flex-1`}>Environment</div>
        <div className={`${caps} w-64 shrink-0`}>Tracking branch</div>
        <div className={`${caps} w-28 shrink-0 text-right`}>Skip superseded</div>
      </div>
      <TrackingRow env="prod" control={<BranchInput branch="main" />} supersede />
      <TrackingRow env="staging" control={<BranchInput />} supersede={false} />
      <TrackingRow
        env="preview"
        control={<LabeledSwitch checked label="Deploy pull requests" />}
        supersede={false}
      />
    </Page>
  );
}

const build: {
  title: string;
  description: string;
  mark: string;
  value?: string;
  placeholder: string;
}[] = [
  {
    title: "Trigger config file",
    description: "Path relative to your repo root. Auto-detected by default.",
    mark: "config-file",
    placeholder: "trigger.config.ts",
  },
  {
    title: "Install command",
    description: "Runs from your repo root. Auto-detected by default.",
    mark: "install",
    placeholder: "e.g., pnpm install",
  },
  {
    title: "Pre-build command",
    description: "Runs from your repo root, before the build.",
    mark: "pre-build",
    value: "pnpm run prisma:generate",
    placeholder: "e.g., npm run prisma:generate",
  },
];

export function ProjectSettingsBuildFigure() {
  return (
    <Page>
      <SettingsHeader
        title="Build settings"
        description={
          <>
            Applies to deployments triggered from GitHub, and CLI deployments run with the{" "}
            <span className="px-1 py-0.5 rounded border border-grid-bright bg-background-bright text-text-bright font-mono text-wrap text-xs whitespace-nowrap">
              --native-build
            </span>{" "}
            flag.
          </>
        }
      />
      {build.map((row) => (
        <SettingsRow
          key={row.mark}
          align="items-start"
          title={row.title}
          description={row.description}
          action={
            <div className="flex w-64 flex-col gap-1">
              <div data-mark={row.mark} data-mark-badge="left" className={input}>
                <div
                  className={`${inputText} ${row.value ? "text-text-bright" : "text-text-dimmed"}`}
                >
                  {row.value ?? row.placeholder}
                </div>
              </div>
            </div>
          }
        />
      ))}
      <div className="flex justify-end gap-2 py-4">
        <Button disabled>Save</Button>
      </div>
    </Page>
  );
}
