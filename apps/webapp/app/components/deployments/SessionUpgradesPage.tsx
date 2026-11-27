import { BookOpenIcon, ShieldCheckIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher, useLocation, useNavigation } from "@remix-run/react";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { InlineCode } from "~/components/code/InlineCode";
import {
  SKEW_PROTECTION_ACTION,
  thresholdSetByLabel,
  UpgradeSessionsDialog,
  versionSkewText,
} from "~/components/deployments/SkewProtectionThreshold";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import {
  DetailHeader,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import { DetailTableTab } from "~/components/primitives/detail/DetailSections";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type {
  SkewProtectionAgentRow,
  SkewProtectionThresholdChangeItem,
} from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import { cn } from "~/utils/cn";
import { docsPath, v3AgentTaskPath, v3SessionsPath } from "~/utils/pathBuilder";

// The Session upgrades page, laid out like the detail page template (header, tabs, property rail):
// the environment's skew protection threshold in the header, Agents and History tabs.

// Dates arrive as JSON strings from the loader.
type HistoryChange = Omit<SkewProtectionThresholdChangeItem, "createdAt"> & {
  createdAt: string | Date;
};

type Threshold = NonNullable<SkewProtectionAgentRow["threshold"]>;

type SessionUpgradesPageData = {
  currentVersion: string | null;
  threshold: Omit<Threshold, "scope"> | null;
  agents: SkewProtectionAgentRow[];
  changes: HistoryChange[];
  midTurnHandover: boolean;
  environmentId: string;
  canWriteDeployments: boolean;
};

const NO_PERMISSION = "You don't have permission to change thresholds";

function DocsButton() {
  return (
    <LinkButton
      variant="docs/small"
      LeadingIcon={BookOpenIcon}
      to={docsPath("deployment/skew-protection-threshold")}
    >
      Session upgrades docs
    </LinkButton>
  );
}

function UpgradeSessionsButton({ data }: { data: SessionUpgradesPageData }) {
  if (!data.canWriteDeployments) {
    return (
      <Button
        variant="primary/small"
        LeadingIcon={ShieldCheckIcon}
        disabled
        tooltip={NO_PERMISSION}
      >
        Upgrade sessions
      </Button>
    );
  }
  return (
    <UpgradeSessionsDialog environmentId={data.environmentId}>
      <Button variant="primary/small" LeadingIcon={ShieldCheckIcon}>
        Upgrade sessions
      </Button>
    </UpgradeSessionsDialog>
  );
}

/**
 * Clears the environment's threshold, or one task's own. In a row menu it submits as a navigation
 * (like the Deployments row menu), so the menu can close at once without cancelling the request.
 */
function ClearThresholdButton({
  data,
  task,
  appearance,
  onSubmit,
}: {
  data: SessionUpgradesPageData;
  task?: string;
  appearance: "button" | "menu";
  onSubmit?: () => void;
}) {
  const project = useProject();
  const location = useLocation();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const action = SKEW_PROTECTION_ACTION(project.id);
  const busy = appearance === "menu" ? navigation.formAction === action : fetcher.state !== "idle";
  const FormComponent = appearance === "menu" ? Form : fetcher.Form;

  const label = task ? "Clear threshold" : "Clear";
  const common = {
    type: "submit" as const,
    name: "redirectUrl",
    value: `${location.pathname}${location.search}`,
    disabled: busy || !data.canWriteDeployments,
    tooltip: data.canWriteDeployments ? undefined : NO_PERMISSION,
  };

  return (
    <FormComponent action={action} method="post" onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="clear" />
      <input type="hidden" name="environmentId" value={data.environmentId} />
      {task && <input type="hidden" name="task" value={task} />}
      {appearance === "menu" ? (
        <Button
          {...common}
          variant="small-menu-item"
          LeadingIcon={XCircleIcon}
          leadingIconClassName="text-text-dimmed"
          fullWidth
          textAlignLeft
        >
          {label}
        </Button>
      ) : (
        <Button {...common} variant="secondary/small" LeadingIcon={busy ? Spinner : undefined}>
          {label}
        </Button>
      )}
    </FormComponent>
  );
}

function SetBy({ threshold }: { threshold: Omit<Threshold, "scope"> }) {
  return (
    <>
      {thresholdSetByLabel(threshold)},{" "}
      <RelativeDateTime date={threshold.setAt} capitalize={false} />
    </>
  );
}

function InCode({
  inCode,
  midTurnHandover,
  long = false,
}: {
  inCode: SkewProtectionAgentRow["inCode"];
  midTurnHandover: boolean;
  long?: boolean;
}) {
  switch (inCode.type) {
    case "versionSkew": {
      const text = versionSkewText(inCode.versionSkew, midTurnHandover) ?? inCode.versionSkew;
      return long ? (
        <span className="flex flex-col items-start gap-1">
          <InlineCode variant="extra-small">{inCode.versionSkew}</InlineCode>
          <span className="text-xs text-text-dimmed">{text}</span>
        </span>
      ) : (
        <SimpleTooltip
          button={<InlineCode variant="extra-small">{inCode.versionSkew}</InlineCode>}
          content={text}
          disableHoverableContent
        />
      );
    }
    case "custom":
      return <span className="text-text-dimmed">Custom agent</span>;
    case "not-reported":
      return <span className="text-text-dimmed">Not reported by this version's SDK</span>;
    case "not-in-current":
      return <span className="text-text-dimmed">Not an agent in the current version</span>;
  }
}

const IN_CODE_TOOLTIP = (
  <Paragraph variant="small">
    The agent's <InlineCode variant="extra-small">versionSkew</InlineCode> in the current version:
    when its sessions move to a newer version on their own.
  </Paragraph>
);

const SET_ON_TOOLTIP = (
  <div className="max-w-xs space-y-1 p-1 text-left text-xs text-text-dimmed">
    <p>
      <span className="text-text-bright">Environment</span>: the threshold for every agent in this
      environment.
    </p>
    <p>
      <span className="text-text-bright">Agent</span>: the agent's own threshold. The higher of the
      agent's and the environment's applies.
    </p>
  </div>
);

function ThresholdCell({
  threshold,
  lowerOwnVersion,
}: Pick<SkewProtectionAgentRow, "threshold" | "lowerOwnVersion">) {
  if (!threshold) return <span className="text-text-dimmed">–</span>;
  return (
    <span className={threshold.scope === "task" ? "text-text-bright" : undefined}>
      Before <span className="tabular-nums">{threshold.version}</span>
      {lowerOwnVersion && (
        <span className="block text-xs text-text-dimmed">
          Its own, before <span className="tabular-nums">{lowerOwnVersion}</span>, is lower
        </span>
      )}
    </span>
  );
}

function setOnText(threshold: SkewProtectionAgentRow["threshold"]) {
  return threshold ? (threshold.scope === "task" ? "Agent" : "Environment") : "–";
}

function AgentName({ task }: { task: string }) {
  return (
    <span className="flex items-center gap-2">
      <CubeSparkleIcon className="size-[1.125rem] shrink-0 text-agents" />
      <span className="text-text-bright">{task}</span>
    </span>
  );
}

function useAgentPaths() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return {
    agent: (task: string) => v3AgentTaskPath(organization, project, environment, task),
    sessions: (task: string) =>
      `${v3SessionsPath(organization, project, environment)}?${new URLSearchParams({
        taskIdentifiers: task,
      }).toString()}`,
  };
}

/** The row menu: the actions first, then where to look. */
function AgentRowMenu({
  data,
  agent,
}: {
  data: SessionUpgradesPageData;
  agent: SkewProtectionAgentRow;
}) {
  const paths = useAgentPaths();
  const inCurrent = agent.inCode.type !== "not-in-current";
  return (
    <TableCellMenu
      isSticky
      // oxlint-disable-next-line react/no-unstable-nested-components -- Render prop: the menu passes its close handler so a finished action can dismiss it.
      popoverContent={(closeMenu) => (
        <>
          {inCurrent &&
            (data.canWriteDeployments ? (
              <UpgradeSessionsDialog
                environmentId={data.environmentId}
                task={agent.task}
                onSet={closeMenu}
              >
                <Button
                  variant="small-menu-item"
                  LeadingIcon={ShieldCheckIcon}
                  leadingIconClassName="text-blue-500"
                  fullWidth
                  textAlignLeft
                >
                  Upgrade sessions…
                </Button>
              </UpgradeSessionsDialog>
            ) : (
              <Button
                variant="small-menu-item"
                LeadingIcon={ShieldCheckIcon}
                leadingIconClassName="text-blue-500"
                fullWidth
                textAlignLeft
                disabled
                tooltip={NO_PERMISSION}
              >
                Upgrade sessions…
              </Button>
            ))}
          {(agent.threshold?.scope === "task" || agent.lowerOwnVersion) && (
            <ClearThresholdButton
              data={data}
              task={agent.task}
              appearance="menu"
              onSubmit={closeMenu}
            />
          )}
          {inCurrent && (
            <>
              <PopoverMenuItem
                icon={CubeSparkleIcon}
                leadingIconClassName="text-agents size-[1.125rem]"
                title="View agent"
                to={paths.agent(agent.task)}
              />
              <PopoverMenuItem
                icon={AIChatIcon}
                leadingIconClassName="text-sessions size-[1.125rem]"
                title="View sessions"
                to={paths.sessions(agent.task)}
              />
            </>
          )}
        </>
      )}
    />
  );
}

/** One row per agent: its `versionSkew` in code and the threshold its sessions follow. */
function AgentsTable({ data, className }: { data: SessionUpgradesPageData; className?: string }) {
  const paths = useAgentPaths();
  return (
    <Table containerClassName={className} showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Agent</TableHeaderCell>
          <TableHeaderCell tooltip={IN_CODE_TOOLTIP}>In code</TableHeaderCell>
          <TableHeaderCell>Threshold</TableHeaderCell>
          <TableHeaderCell
            tooltip={SET_ON_TOOLTIP}
            tooltipContentClassName="max-w-max"
            disableTooltipHoverableContent
          >
            Set on
          </TableHeaderCell>
          <TableHeaderCell className="w-[1%]">
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.agents.length === 0 ? (
          <TableBlankRow colSpan={5}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No agents in the current version.
            </Paragraph>
          </TableBlankRow>
        ) : (
          data.agents.map((agent) => {
            const to = agent.inCode.type === "not-in-current" ? undefined : paths.agent(agent.task);
            return (
              <TableRow key={agent.task}>
                <TableCell to={to} isTabbableCell>
                  <AgentName task={agent.task} />
                </TableCell>
                <TableCell to={to}>
                  <InCode inCode={agent.inCode} midTurnHandover={data.midTurnHandover} />
                </TableCell>
                <TableCell to={to}>
                  <ThresholdCell
                    threshold={agent.threshold}
                    lowerOwnVersion={agent.lowerOwnVersion}
                  />
                </TableCell>
                <TableCell to={to}>{setOnText(agent.threshold)}</TableCell>
                <AgentRowMenu data={data} agent={agent} />
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

const SOURCE_TEXT: Record<HistoryChange["source"], string> = {
  dashboard: "from the dashboard",
  api: "through the API",
  rollback: "on rollback",
  migrated: "by Trigger.dev",
};

/** "Sam, from the dashboard", or "Through the API" when no one was recorded. */
function changeBy(change: HistoryChange): string {
  const source = SOURCE_TEXT[change.source] ?? change.source;
  return change.actorName
    ? `${change.actorName}, ${source}`
    : source.charAt(0).toUpperCase() + source.slice(1);
}

function changeShortText(change: HistoryChange): string {
  switch (change.kind) {
    case "set":
      return `Set to ${change.version}`;
    case "cleared":
      return `Cleared ${change.version}`;
    case "cleared-by-rollback":
      return change.currentVersion
        ? `Cleared ${change.version} by rollback to ${change.currentVersion}`
        : `Cleared ${change.version} by rollback`;
  }
}

/** Every threshold change in the environment, newest first, as a table. */
function HistoryTable({ data, className }: { data: SessionUpgradesPageData; className?: string }) {
  const paths = useAgentPaths();
  // Only a current agent has a page: a standard task or a removed agent stays plain text.
  // Only agents in the current deployment have a page; the list also holds other tasks with a threshold.
  const agents = new Set(
    data.agents.filter((agent) => agent.inCode.type !== "not-in-current").map((agent) => agent.task)
  );
  return (
    <Table containerClassName={className} showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Change</TableHeaderCell>
          <TableHeaderCell>Agent</TableHeaderCell>
          <TableHeaderCell>By</TableHeaderCell>
          <TableHeaderCell alignment="right">Date</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.changes.length === 0 ? (
          <TableBlankRow colSpan={4}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No threshold changes yet.
            </Paragraph>
          </TableBlankRow>
        ) : (
          data.changes.map((change) => (
            <TableRow key={change.id}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      change.kind === "set" ? "bg-blue-500" : "bg-charcoal-500"
                    )}
                  />
                  <span className="text-text-bright">{changeShortText(change)}</span>
                </span>
              </TableCell>
              <TableCell
                to={change.task && agents.has(change.task) ? paths.agent(change.task) : undefined}
              >
                {change.task ?? <span className="text-text-dimmed">Every agent</span>}
              </TableCell>
              <TableCell>{changeBy(change)}</TableCell>
              <TableCell alignment="right">
                <DateTime date={change.createdAt} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

const TABS = ["agents", "history"] as const;

export function SessionUpgradesPage({ data }: { data: SessionUpgradesPageData }) {
  const [tab, setTab] = useDetailTab(TABS);
  const own = data.agents.filter(
    (agent) => agent.threshold?.scope === "task" || agent.lowerOwnVersion
  ).length;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Session upgrades" />
        <PageAccessories>
          <DocsButton />
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <DetailPage
          id="session-upgrades"
          header={
            <DetailHeader
              icon={ShieldCheckIcon}
              iconClassName={data.threshold ? "text-blue-500" : "text-text-dimmed"}
              title={
                data.threshold ? `Before ${data.threshold.version}` : "No environment threshold"
              }
              meta={[
                ...(data.threshold ? ["Every agent"] : []),
                data.threshold ? (
                  <SetBy key="set" threshold={data.threshold} />
                ) : (
                  "Sessions stay on the version they started on"
                ),
                `Current version ${data.currentVersion ?? "–"}`,
              ]}
              secondaryActions={
                data.threshold ? (
                  <ClearThresholdButton data={data} appearance="button" />
                ) : undefined
              }
              primaryAction={<UpgradeSessionsButton data={data} />}
            />
          }
          tabs={
            <DetailTabs
              tabs={[
                { id: "agents", label: "Agents", count: data.agents.length },
                { id: "history", label: "History", count: data.changes.length },
              ]}
              activeTab={tab}
              onTabChange={(next) => setTab(next)}
            />
          }
          rail={
            <PropertyRail>
              <PropertyGroup title="Details">
                <PropertyPair>
                  <DetailProperty label="Current version">
                    {data.currentVersion ?? "–"}
                  </DetailProperty>
                  <DetailProperty label="Every agent">
                    {data.threshold ? `Before ${data.threshold.version}` : "None"}
                  </DetailProperty>
                  {data.threshold && (
                    <DetailProperty label="Set">
                      <span>
                        <SetBy threshold={data.threshold} />
                      </span>
                    </DetailProperty>
                  )}
                </PropertyPair>
              </PropertyGroup>
              <PropertyGroup title="Agents">
                <PropertyPair>
                  <DetailProperty label="Following every agent">
                    {String(
                      data.agents.filter((agent) => agent.threshold?.scope === "environment").length
                    )}
                  </DetailProperty>
                  <DetailProperty label="With their own threshold">{String(own)}</DetailProperty>
                  <DetailProperty label="With no threshold">
                    {String(data.agents.filter((agent) => !agent.threshold).length)}
                  </DetailProperty>
                </PropertyPair>
              </PropertyGroup>
            </PropertyRail>
          }
        >
          {tab === "agents" ? (
            <DetailTableTab>
              <AgentsTable data={data} />
            </DetailTableTab>
          ) : (
            <DetailTableTab>
              <HistoryTable data={data} />
            </DetailTableTab>
          )}
        </DetailPage>
      </PageBody>
    </PageContainer>
  );
}
