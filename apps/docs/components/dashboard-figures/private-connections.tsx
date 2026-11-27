// The organization's Private Connections settings page and its Add Private Connection page.
// Drawn from source: the reference dashboard has no private connections (the pages redirect
// without access). The settings side menu is cropped off, and the responsive classes (md:mt-14,
// sm:grid-cols-4) are written at their desktop values so a phone-width page keeps the layout. The
// webapp files they mirror are their `sources` in lib/dashboard-figures.ts.
import {
  ClipboardDocumentIcon,
  CommandLineIcon,
  DocumentTextIcon,
  SparklesIcon,
} from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import { Button, PageHeader } from "./chrome";
import { FormButtons, Input } from "./form-parts";
import * as I from "./icons";

type P = { className?: string };

const SERVICE = "com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0";

/** PageBody with MainHorizontallyCenteredContainer (max-w-3xl) and the page's Header2 and intro. */
function Page({
  nav,
  title,
  intro,
  children,
}: {
  nav: ReactNode;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-dimmed">
      {nav}
      <div className="w-full overflow-hidden">
        <div className="mx-auto mt-14 max-w-3xl p-1">
          <div>
            <div className="mb-4 border-b border-grid-dimmed pb-3">
              <div className="font-sans text-base leading-6 font-semibold tracking-tight mb-2 text-text-bright">
                {title}
              </div>
              <div className="font-sans text-sm font-medium text-text-dimmed">{intro}</div>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Private Connections (settings.private-connections._index) ----

type Status = "PENDING" | "PROVISIONING" | "ACTIVE" | "ERROR" | "DELETING";

// STATUS_COLORS; the dashboard's system: variants are its own theme.
const statusColors: Record<Status, string> = {
  PENDING: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  PROVISIONING: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  ACTIVE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  ERROR: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  DELETING: "bg-charcoal-500/10 text-text-dimmed",
};

type Connection = { name: string; status: Status; service: string; ip?: string };

const connections: Connection[] = [
  { name: "Acme database", status: "ACTIVE", service: SERVICE, ip: "10.0.12.34" },
  {
    name: "Redis cache",
    status: "PROVISIONING",
    service: "com.amazonaws.vpce.us-east-1.vpce-svc-0fedcba9876543210",
  },
];

function CopyButton() {
  return (
    <span className="ml-1 inline-flex items-center text-text-dimmed">
      <ClipboardDocumentIcon className="h-3.5 w-3.5" />
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center text-xs text-text-dimmed">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ConnectionCard({ c, first }: { c: Connection; first: boolean }) {
  return (
    <div className="rounded-lg border border-grid-dimmed p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="font-medium text-text-bright">{c.name}</span>
          <span
            data-mark={first ? "status" : undefined}
            className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${statusColors[c.status]}`}
          >
            {c.status}
          </span>
          <span className="ml-auto text-text-dimmed">
            <I.TrashIcon className="h-4 w-4" />
          </span>
        </div>
        <div className="space-y-1">
          <Field label="Service:">
            <span className="truncate font-mono text-text-dimmed">{c.service}</span>
            <CopyButton />
          </Field>
          <Field label="Region:">
            <span>us-east-1</span>
          </Field>
          {c.ip && (
            <Field label="IPs:">
              <span data-mark={first ? "assigned-ip" : undefined} className="flex items-center">
                <span className="truncate font-mono text-emerald-400">{c.ip}</span>
                <CopyButton />
              </span>
            </Field>
          )}
          <Field label="Created:">
            <span>11/25/2026</span>
          </Field>
        </div>
      </div>
    </div>
  );
}

function AddConnection({ mark }: { mark?: string }) {
  return (
    <Button variant="primary" icon={I.PlusIcon} mark={mark} markBadge="left">
      Add Connection
    </Button>
  );
}

export function PrivateConnectionsFigure() {
  return (
    <Page
      nav={
        <PageHeader title="Private Connections">
          <Button variant="docs" icon={I.BookIcon}>
            Private connection docs
          </Button>
          <AddConnection mark="add-connection" />
        </PageHeader>
      }
      title="Private Connections"
      intro="Connect your AWS resources (databases, caches, APIs) to your Trigger.dev tasks via AWS PrivateLink. Connections are organization-wide and work across all projects and environments."
    >
      <div className="flex flex-col gap-3">
        {connections.map((c, i) => (
          <ConnectionCard key={c.name} c={c} first={i === 0} />
        ))}
        <div className="flex justify-center pt-2">
          <AddConnection />
        </div>
      </div>
    </Page>
  );
}

// ---- Add Private Connection (settings.private-connections.new) ----

const cardText = "text-sm font-medium text-text-bright";

function MethodCard({
  icon: Icon,
  iconColor,
  title,
  text,
  selected,
  mark,
}: {
  icon: (p: P) => ReactNode;
  iconColor: string;
  title: string;
  text: string;
  selected?: boolean;
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      data-mark-badge="below"
      className={`rounded-lg border p-4 text-left ${selected ? "border-indigo-500 bg-indigo-500/10" : "border-grid-dimmed"}`}
    >
      <Icon className={`mb-2 h-5 w-5 ${iconColor}`} />
      <div className={cardText}>{title}</div>
      <div className="mt-1 text-xs text-text-dimmed">{text}</div>
    </div>
  );
}

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const smallText = "font-sans text-sm font-medium text-text-dimmed";

export function PrivateConnectionsNewFigure() {
  return (
    <Page
      nav={
        <PageHeader title="Add Private Connection" crumbs={["Private Connections"]}>
          <Button variant="docs" icon={I.BookIcon}>
            Private connection docs
          </Button>
        </PageHeader>
      }
      title="Add Private Connection"
      intro="Connect your AWS resources to Trigger.dev task pods via AWS PrivateLink. You'll need to create a VPC Endpoint Service on your AWS account first."
    >
      <div className="mb-6 grid grid-cols-4 gap-3">
        <MethodCard
          icon={I.PencilSquareIcon}
          iconColor="text-indigo-400"
          title="I have my details"
          text="Already have your VPC Endpoint Service name"
          selected
          mark="details-card"
        />
        <MethodCard
          icon={SparklesIcon}
          iconColor="text-purple-400"
          title="Set up with AI"
          text="Generate a prompt for your AI assistant"
        />
        <MethodCard
          icon={CommandLineIcon}
          iconColor="text-emerald-400"
          title="Set up with Terraform"
          text="Generate a customized Terraform script"
        />
        <MethodCard
          icon={DocumentTextIcon}
          iconColor="text-amber-400"
          title="Step-by-step guide"
          text="Visual instructions for the AWS Console"
        />
      </div>
      <div className="mb-6 rounded-lg border border-grid-dimmed p-4">
        <div className={`${smallText} mb-3`}>
          Add the following AWS account ARN(s) to your VPC Endpoint Service's allowed principals:
        </div>
        <div className="space-y-2">
          {/* ClipboardField primary/medium. */}
          <span
            data-mark="account-arn"
            className="flex items-center text-text-dimmed font-mono rounded border border-border-bright/50 shadow-xs bg-input-bg text-sm w-full"
          >
            <span className="shrink grow w-full min-w-0 bg-transparent border-0 text-sm px-3 rounded-l h-8 leading-8">
              arn:aws:iam::123456789012:root
            </span>
            <span>
              <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-8 px-1.5 bg-accent-fill border border-lavender-500 rounded-l-none">
                <I.ClipboardIcon className="size-4 text-background-dimmed" />
              </div>
            </span>
          </span>
        </div>
      </div>
      <div className="rounded-lg border border-grid-dimmed p-4">
        <div className="font-sans text-sm leading-5 font-semibold mb-2 text-text-bright">
          Connection Details
        </div>
        <div className="flex flex-col gap-y-5">
          <div className="grid w-full items-center gap-1.5">
            <span className={label}>Friendly name</span>
            <Input value="Acme database" />
          </div>
          <div data-mark="service-name" className="grid w-full items-center gap-1.5">
            <span className={label}>VPC Endpoint Service name</span>
            <Input value={SERVICE} />
          </div>
          <div data-mark="target-region" className="grid w-full items-center gap-1.5">
            <span className={label}>Target region</span>
            {/* A native <select>. */}
            <div className="flex w-full items-center justify-between rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-sm text-text-bright">
              us-east-1
              <I.ChevronDownIcon className="size-4 text-text-dimmed" />
            </div>
            <div className="font-sans text-xs font-medium text-text-dimmed">
              Your tasks have recently run in: us-east-1
            </div>
          </div>
          <FormButtons
            cancel={<Button variant="tertiary">Cancel</Button>}
            confirm={
              <Button variant="primary" mark="create" markBadge="left">
                Create Connection
              </Button>
            }
          />
        </div>
      </div>
    </Page>
  );
}
