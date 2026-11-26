// A webhook endpoint's page (github, in Development, no signing secret yet), with the Settings or
// the Test tab open. The page frame is copied from the dashboard's detail-page storybook (its
// "Webhook endpoint: Settings" story); the tabs' content is drawn from source (the reference
// dashboard has no endpoints). The side menu is cropped off, as on the schedules figure. The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { PaperAirplaneIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/20/solid";
import {
  KeyIcon,
  NoSymbolIcon,
  SparklesIcon as SparklesSolid24Icon,
} from "@heroicons/react/24/solid";
import { ClipboardIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, PageHeader } from "./chrome";
import { Option, SmallInput } from "./form-parts";
import * as I from "./icons";
import { Copyable, Group, Property, ResizableHandle, Tab } from "./detail-parts";

const URL = "https://api.trigger.dev/webhooks/v1/ingest/we_k3q8m2x7v9rt";
const hint = "font-sans text-xs font-medium text-text-dimmed";
const smallLabel =
  "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1";

/** StateDot and EndpointStatusBadge: a colored dot and a label. */
function StateDot({ warn, children }: { warn?: boolean; children: string }) {
  return (
    <span className={warn ? "flex items-center gap-1.5 text-warning" : "flex items-center gap-1.5"}>
      <span
        className={warn ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-success"}
      />
      <span>{children}</span>
    </span>
  );
}

/** The rail; once the secret is generated (the Test figure) the secret reads Ready. */
function Rail({ ready }: { ready: boolean }) {
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden bg-background-bright pb-4 pt-1">
      <Group title="Details">
        <div className="flex flex-col gap-y-3">
          <Property label="ID">
            <Copyable truncate value="wh_k3q8m2x7v9rt" />
          </Property>
          <Property label="Status">
            <StateDot>Active</StateDot>
          </Property>
          <Property label="Source">
            <span className="font-mono text-xs">github</span>
          </Property>
          <Property label="Tenant">
            <span className="text-text-dimmed">None</span>
          </Property>
          <Property label="External ref">
            <span className="text-text-dimmed">None</span>
          </Property>
          <Property label="Created">
            <span>25 Nov 2026, 10:12:40 am</span>
          </Property>
          <Property label="Updated">
            <span>25 Nov 2026, 10:12:40 am</span>
          </Property>
        </div>
      </Group>
      <Group title="Connect">
        <Property label="Webhook URL">
          <Copyable truncate value={URL} />
        </Property>
        <Property label="Signing secret">
          {ready ? <StateDot>Ready</StateDot> : <StateDot warn>Needs signing secret</StateDot>}
        </Property>
      </Group>
      <Group title="Signature">
        <div className="flex flex-col gap-y-3">
          <Property label="Scheme">
            <span className="font-mono text-xs">github (hmac)</span>
          </Property>
          <Property label="Header">
            <span className="truncate font-mono text-xs">x-hub-signature-256</span>
          </Property>
          <Property label="Algorithm">
            <span className="font-mono text-xs">sha256 / hex</span>
          </Property>
        </div>
      </Group>
    </div>
  );
}

type EndpointTab = "test" | "settings";

function EndpointPage({ tab, children }: { tab: EndpointTab; children: ReactNode }) {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
      <PageHeader crumbs={["Endpoints"]} title="github" detail>
        <Button variant="docs" icon={I.BookIcon}>
          Webhooks docs
        </Button>
      </PageHeader>
      <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
        <div className="flex items-end gap-4 border-b border-grid-bright bg-background-bright px-4 pb-3 pt-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid size-[46px] flex-none place-items-center rounded-md bg-background-hover">
              <I.WebhooksIcon className="size-5 text-webhooks" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="truncate min-w-0 text-text-bright font-mono text-[1.0625rem] font-medium leading-6">
                  github
                </span>
                <div className="flex flex-none items-center gap-1 rounded size-6 justify-center text-text-faint">
                  <ClipboardIcon className="size-3.5" />
                </div>
                <div className="flex flex-none items-center text-sm">
                  <StateDot>Active</StateDot>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-text-dimmed">
                <span className="flex shrink-0 items-center gap-1">
                  <span>
                    Source <span className="font-mono">github</span>
                  </span>
                </span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">Default tenant</span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">
                  <span>No deliveries in this period</span>
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button icon={SparklesIcon} iconClassName="size-3.5 text-text-dimmed">
              Copy setup prompt
            </Button>
            <Button variant="primary" icon={PaperAirplaneIcon}>
              Send test event
            </Button>
          </div>
        </div>
        <div className="flex h-10 shrink-0 border-b border-grid-bright items-stretch gap-x-3 bg-background-bright px-4">
          <div className="flex min-w-0 flex-1 items-stretch gap-x-5">
            <Tab label="Deliveries" mark={tab === "test" ? "deliveries-tab" : undefined} />
            <Tab label="Subscribers" count="1" />
            <Tab label="Waiters" />
            <Tab
              label="Test"
              selected={tab === "test"}
              mark={tab === "test" ? "test-tab" : undefined}
            />
            <Tab
              label="Settings"
              selected={tab === "settings"}
              mark={tab === "settings" ? "settings-tab" : undefined}
            />
          </div>
        </div>
        <div className="flex w-full overflow-hidden h-full max-h-full">
          <div className="min-w-0 flex-1">
            <div className="h-full min-h-0 overflow-hidden">{children}</div>
          </div>
          <ResizableHandle />
          <div className="min-w-0" style={{ width: 320 }}>
            <Rail ready={tab === "test"} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Settings tab ----

function SettingGroup({
  title,
  danger,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex max-w-[47.5rem] flex-col gap-1.5">
      <div
        className={`-mb-1 text-[0.6875rem] font-medium uppercase tracking-[0.07em] ${danger ? "text-error" : "text-text-faint"}`}
      >
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  value,
  control,
}: {
  title: string;
  description: string;
  value?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-grid-dimmed py-2.5 text-sm">
      <div className="flex w-[15.625rem] flex-none flex-col gap-px">
        <span className="font-medium text-text-bright">{title}</span>
        <span className="text-xs text-text-faint">{description}</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-6 text-text-dimmed">
        {value !== undefined && (
          <div className="flex min-w-0 items-center justify-end truncate">{value}</div>
        )}
        {control && <div className="flex flex-none items-center">{control}</div>}
      </div>
    </div>
  );
}

const VERIFICATION = [
  ["Scheme", "github (hmac)"],
  ["Signature header", "x-hub-signature-256"],
  ["Algorithm", "sha256 / hex"],
  ["Signing string", "raw body"],
];

export function WebhookEndpointSettingsFigure() {
  return (
    <EndpointPage tab="settings">
      <div className="h-full overflow-hidden px-4 pb-8 pt-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
          <SettingGroup title="Connect">
            <SettingRow
              title="Webhook URL"
              description="Paste this into github as the delivery URL"
              value={
                <span data-mark="webhook-url" data-mark-badge="left" className="flex min-w-0">
                  <Copyable truncate value={URL} />
                </span>
              }
            />
            <SettingRow
              title="Signing secret"
              description="Deliveries are verified against it, and rejected without one"
              value={<StateDot warn>Needs signing secret</StateDot>}
              control={
                <div className="flex items-center gap-2">
                  <Button variant="tertiary" icon={KeyIcon} mark="set-secret" markBadge="below">
                    Set signing secret
                  </Button>
                  <Button icon={SparklesSolid24Icon} mark="generate-secret" markBadge="below">
                    Generate secret
                  </Button>
                </div>
              }
            />
          </SettingGroup>
          <SettingGroup title="Verification">
            <div className="max-w-[47.5rem] py-2.5">
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                  {VERIFICATION.map(([label, value]) => (
                    <div key={label} className="contents">
                      <div className="text-text-dimmed">{label}</div>
                      <div className="truncate font-mono text-xs leading-5 text-text-bright">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
                <div className={hint}>
                  Sign deliveries with the github scheme above, using the signing secret.
                </div>
              </div>
            </div>
          </SettingGroup>
          <SettingGroup title="Danger zone" danger>
            <SettingRow
              title="Disable endpoint"
              description="Stops accepting deliveries until it's enabled again"
              control={
                <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-error">
                  <div className="relative flex w-full items-center">
                    <div className="justify-center flex w-full items-center text-white gap-x-2.5">
                      <NoSymbolIcon className="h-3.5 -mx-1 text-white shrink-0 justify-start" />
                      <span className="mx-auto grow self-center truncate">Disable…</span>
                    </div>
                  </div>
                </div>
              }
            />
          </SettingGroup>
        </div>
      </div>
    </EndpointPage>
  );
}

// ---- Test tab (webhookConsole/WebhookComposer.tsx) ----

/** Tabs.tsx TabButton, underline variant: every label bright, the active one underlined. */
function SourceTab({ active, children }: { active?: boolean; children: string }) {
  return (
    <div className="group/tab flex flex-col items-center pt-1">
      <div className="flex items-center gap-1">
        <span className="text-sm text-text-bright">{children}</span>
      </div>
      <div className={`mt-1 h-0.5 w-full ${active ? "bg-indigo-500" : "opacity-0"}`} />
    </div>
  );
}

/** The default body as CodeMirror draws it (filling the panel): line numbers, gutter, JSON tokens. */
function BodyEditor() {
  const lines: ReactNode[] = [
    <span key="1">{"{"}</span>,
    <span key="2">
      {"  "}
      <span className="text-editor-name">"message"</span>:{" "}
      <span className="text-editor-string">"hello from the webhook console"</span>
    </span>,
    <span key="3">{"}"}</span>,
  ];
  return (
    <div className="flex h-full bg-editor-background font-mono text-[14px] leading-[1.4] text-editor-foreground">
      <div className="flex shrink-0 py-1 text-editor-comment">
        <div>
          {lines.map((_, i) => (
            <div key={i} className="min-w-5 pl-[5px] pr-[3px] text-right">
              {i + 1}
            </div>
          ))}
        </div>
        <div className="w-4" />
      </div>
      <div className="grow py-1">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre pl-1.5 pr-0.5">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WebhookEndpointTestFigure() {
  return (
    <EndpointPage tab="test">
      <div className="flex h-full max-h-full flex-col">
        <div className="flex min-h-0 grow">
          <div className="min-w-0 flex-1">
            <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
              <div className="flex h-9 items-center border-b border-grid-dimmed bg-background-bright px-3">
                <div className="flex gap-x-6 border-b border-grid-bright -mb-px">
                  <SourceTab active>Body</SourceTab>
                  <SourceTab>Library</SourceTab>
                  <SourceTab>Replay</SourceTab>
                </div>
              </div>
              <div className="relative flex-1 overflow-hidden">
                <BodyEditor />
              </div>
            </div>
          </div>
          <ResizableHandle />
          <div className="min-w-0" style={{ width: 360 }}>
            <div className="flex h-full flex-col gap-4 overflow-hidden bg-background-bright p-3">
              <Option
                name="Signature"
                value="Signed (valid)"
                help="Signed server-side with the endpoint's stored secret."
              />
              <div
                data-mark="headers"
                data-mark-badge="below"
                className="grid items-center gap-1.5 max-w-md w-full"
              >
                <div className={smallLabel}>Headers</div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0 flex-1">
                      <SmallInput value="x-github-event" mono />
                    </div>
                    <div className="min-w-0 flex-1">
                      <SmallInput value="push" mono />
                    </div>
                    <div className="shrink-0 rounded p-1 text-text-dimmed">
                      <XMarkIcon className="size-3.5" />
                    </div>
                  </div>
                  <div className="flex w-fit items-center gap-1 rounded py-0.5 pr-1.5 text-xs text-text-dimmed">
                    <I.PlusIcon className="size-3.5" />
                    Add header
                  </div>
                </div>
                <div className={hint}>
                  Optional provider routing headers (e.g. x-github-event). The signature header is
                  added automatically.
                </div>
              </div>
              <div className="grid items-center gap-1.5 max-w-md w-full">
                <div className={smallLabel}>Webhook URL</div>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-mono text-xxs font-semibold uppercase text-text-dimmed">
                    POST
                  </span>
                  <Copyable truncate value={URL} />
                </span>
                <div className={hint}>
                  The public URL providers POST to. Test sends run the same pipeline in-process.
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-grid-bright bg-background-dimmed p-2">
          <span className="text-xs text-text-dimmed">
            Signs with the endpoint's secret and runs the full delivery pipeline.
          </span>
          <div className="flex items-center gap-2">
            <Button variant="primary" mark="send-event" markBadge="left">
              Send event
            </Button>
          </div>
        </div>
      </div>
    </EndpointPage>
  );
}
