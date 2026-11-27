/**
 * Dashboard figures: dashboard screens drawn with the dashboard's own markup and tokens, in place
 * of screenshots (`<DashboardFigure name="..." />`, components/dashboard-figure.tsx).
 *
 * This is the registry. Per figure: what it shows in words (the alt text, and what the .md
 * routes, MCP and Ask AI get instead of the drawing), its canvas size, and the marks a page can
 * ring with `highlight`. No React here: the markdown routes and the scripts import it.
 * How to add or refresh a figure: .claude/skills/docs-dashboard-figures/SKILL.md.
 */

type DashboardFigureMeta = {
  /** What the figure shows, for screen readers and agents: the screen, then the controls the docs name. */
  description: string;
  /** Canvas size in CSS pixels: the dashboard's real size for the region the figure crops to. */
  width: number;
  height: number;
  /** Elements a page can ring with `highlight="<mark>"`: `data-mark="<mark>"` in the figure. */
  marks: readonly string[];
  /**
   * The dashboard files the drawing mirrors, from the repo root. `check:figures` reports a figure
   * whose files changed since its stamp (lib/dashboard-figures.stamps.json).
   */
  sources: readonly string[];
};

const W = "apps/webapp/app";
const ROUTES = `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam`;
const P = `${W}/components/primitives`;

/** What every full-page figure draws: the side menu, page header, buttons, environment labels. */
const APP_FRAME = [
  `${W}/components/navigation/SideMenu.tsx`,
  `${W}/components/navigation/SideMenuItem.tsx`,
  `${W}/components/navigation/SideMenuSection.tsx`,
  `${W}/components/navigation/sideMenuSections.tsx`,
  `${P}/PageHeader.tsx`,
  `${P}/Buttons.tsx`,
  `${W}/components/environments/EnvironmentLabel.tsx`,
];

/** What every run page figure draws: the header, toolbar, trace tree and timeline, inspector. */
const RUN_PAGE = [
  `${ROUTES}.runs.$runParam/route.tsx`,
  `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx`,
  `${W}/components/runs/v3/trace/TraceToolbar.tsx`,
  `${W}/components/runs/v3/trace/TasksTreeView.tsx`,
  `${W}/components/runs/v3/trace/TimelineView.tsx`,
  `${W}/components/runs/v3/RunIcon.tsx`,
  `${W}/components/runs/v3/SpanTitle.tsx`,
  `${W}/components/run/RunTimeline.tsx`,
  `${W}/components/code/CodeBlock.tsx`,
  `${P}/Resizable.tsx`,
  `${P}/Switch.tsx`,
  `${P}/SearchInput.tsx`,
  `${P}/PageHeader.tsx`,
  `${P}/Buttons.tsx`,
];

/** The webapp's tokens, mirrored by app/dashboard-figures.css (stamped as "dashboard-figures.css"). */
export const figureStyleSources = [`${W}/tailwind.css`] as const;

export const dashboardFigures = {
  alerts: {
    description:
      "The Project alerts table on the Alerts page in the dashboard, with the New alert button at the top right. Each row is an alert: its name, alert types (Task run failure, Deployment failure, Deployment success), channel (an email address or a webhook URL with its masked secret), Enabled status and environment (Production). The last row's three-dot menu is open, showing Disable and Delete.",
    width: 1216,
    height: 260,
    marks: ["new-alert", "row-menu", "disable", "delete"],
    sources: [
      `${ROUTES}.alerts/route.tsx`,
      `${W}/components/alerts/LegacyAlertChannelsPage.tsx`,
      `${W}/components/alerts/AlertChannelsBody.tsx`,
      `${W}/components/runs/v3/EnabledStatus.tsx`,
      `${P}/Table.tsx`,
      `${P}/DetailCell.tsx`,
      `${P}/ClipboardField.tsx`,
      `${P}/Popover.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Headers.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
    ],
  },
  "alerts-empty": {
    description:
      'The Alerts page in the dashboard for Production before any alert exists, with Alerts selected in the side menu under Manage. An "Adding alerts" card says you can get alerted when deployed runs fail, by Slack, email or webhook, and has an Alerts docs button and the New alert button.',
    width: 1000,
    height: 740,
    marks: ["nav", "new-alert"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.alerts/route.tsx`,
      `${W}/components/alerts/LegacyAlertChannelsPage.tsx`,
      `${W}/components/alerts/AlertsBlankStates.tsx`,
      `${W}/components/layout/AppLayout.tsx`,
    ],
  },
  "alerts-new": {
    description:
      'The New alert dialog. At the top, a segmented control picks the channel: Email (selected), Slack or Webhook. Below: the email address field, "Alert me when" with Task runs fail, Deployments fail and Deployments succeed all checked, the environment (Production), and the Cancel and Save buttons.',
    width: 512,
    height: 452,
    marks: ["channel", "alert-types", "save"],
    sources: [
      `${ROUTES}.alerts.new/route.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/SegmentedControl.tsx`,
      `${P}/Checkbox.tsx`,
      `${P}/Input.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Buttons.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
    ],
  },
  "api-keys": {
    description:
      "The API keys page in the dashboard, with API keys selected in the side menu under Security and the Create API key button at the top right. A table lists each key's name, masked secret key, status (Active), access preset (No restrictions, Trigger only, Observer), allowed IPs, who created it, when it was created and last used, and when it expires. The Root API key is marked Legacy.",
    width: 1440,
    height: 640,
    marks: ["nav", "create"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.apikeys/route.tsx`,
      `${ROUTES}.apikeys/ApiKeyAccessCell.tsx`,
      `${ROUTES}.apikeys/ApiKeyIpRanges.tsx`,
      `${ROUTES}.apikeys/ApiKeyStatus.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
    ],
  },
  "billing-alerts": {
    description:
      "The Billing alerts section of the organization's Billing limits settings page. With a $250.00 billing limit set, alerts are percentages of the limit: under Alert me when I reach, two thresholds (50% ($125.00) and 80% ($200.00)), each with a delete button, then an Add alert button. Below: Email addresses, with sam@example.com and an empty Add another email field, and the Update alerts button at the bottom right.",
    width: 768,
    height: 465,
    marks: ["thresholds", "add-alert", "emails", "update"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.settings.billing-limits/route.tsx`,
      `${W}/components/billing/BillingAlertsSection.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Paragraph.tsx`,
      `${P}/Label.tsx`,
      `${P}/Input.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/FormButtons.tsx`,
      `${P}/TextLink.tsx`,
    ],
  },
  "billing-limit": {
    description:
      "The Billing limit section of the organization's Billing limits settings page. Three options, one per row: My plan limit ($50.00), Custom limit, and I don't want a billing limit. Custom limit is selected, with $250 typed in the amount field below it and a note beside it: when the limit is reached, queued runs are held for 24 hours, then new triggers are rejected until you increase or remove the limit. Below the options: a Cancel in-progress runs when this limit is reached checkbox (unchecked) and the Save billing limit button at the bottom right.",
    width: 768,
    height: 546,
    marks: ["plan", "custom", "amount", "none", "cancel-runs", "save"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.settings.billing-limits/route.tsx`,
      `${W}/components/billing/BillingLimitConfigSection.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Paragraph.tsx`,
      `${P}/RadioButton.tsx`,
      `${P}/Input.tsx`,
      `${P}/Checkbox.tsx`,
      `${P}/Callout.tsx`,
      `${P}/AnimatedCallout.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/FormButtons.tsx`,
    ],
  },
  "bulk-action-create": {
    description:
      'The Runs page in the dashboard with two runs selected (their checkboxes are ticked) and the Create a bulk action panel open on the right. Under Select, 2 individually selected runs is chosen over All runs matching your filters. Below are a Name field, the Bulk action to perform choice between Cancel runs and Replay runs (Replay runs is chosen), an Environment select set to Development and a Version select, disabled in Development. A Preview line reads "You have individually selected 2 runs to be Replayed", and the Replay 2 runs… button is at the bottom right.',
    width: 1240,
    height: 880,
    marks: ["select", "name", "action", "environment", "version", "confirm"],
    sources: [
      `${ROUTES}.runs._index/route.tsx`,
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction.tsx`,
      `${W}/components/runs/v3/BulkActionModeField.tsx`,
      `${W}/components/BulkActionFilterSummary.tsx`,
      `${W}/components/runs/v3/RunFilters.tsx`,
      `${W}/components/runs/v3/AIFilterInput.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${W}/components/runs/v3/RunsDisplayOptions.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/runColumns.ts`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/versions/VersionLabel.tsx`,
      `${W}/components/MachineLabelCombo.tsx`,
      `${W}/utils/versionLabel.ts`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/ShortcutKey.tsx`,
      `${P}/Resizable.tsx`,
      `${P}/Accordion.tsx`,
      `${P}/RadioButton.tsx`,
      `${P}/Label.tsx`,
      `${P}/Hint.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Select.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Checkbox.tsx`,
    ],
  },
  "bulk-actions": {
    description:
      'A finished bulk action\'s page in the dashboard: "Replay of 2 runs", the two runs selected on the Runs page replayed into Development. The header shows its status (Completed), "Replay", "2 runs" and who started it, with View runs, Replay new runs and a disabled Abort button on the right. The New runs tab lists the two runs the replay created, with Open in runs list above the table. The rail on the right starts with Progress: "Runs processed 2 / 2", a full green bar, "2 replayed successfully" and "0 failed". Below are Details (ID, status, type, created and completed times, duration and who created it) and Selection (2 runs selected, replayed into Development, current version, same region as the original run).',
    width: 1200,
    height: 900,
    marks: ["view-runs", "replay", "progress"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.bulk-actions_.$bulkActionParam/route.tsx`,
      `${W}/routes/storybook.detail-pages/route.tsx`,
      `${W}/components/runs/v3/BulkAction.tsx`,
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/runColumns.ts`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${W}/components/UserProfilePhoto.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${P}/detail/DetailPage.tsx`,
      `${P}/detail/DetailSections.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Resizable.tsx`,
      `${P}/Table.tsx`,
      `${P}/CopyableText.tsx`,
    ],
  },
  deployments: {
    description:
      "The Deploys page in the dashboard, in Production, with Deploys selected in the side menu under Deployments. A table lists each deployment with its short code, version, status, runtime, task count, when it was deployed, who deployed it, and its git branch and commit. The current deployment, version 20261125.1, has a Current badge next to its short code; an older version, 20261124.1, is below it. Above the table: a version search, Status and Branch filters and an Activity switch.",
    width: 1200,
    height: 560,
    marks: ["nav", "current"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.deployments/route.tsx`,
      `${W}/components/runs/v3/DeploymentFilters.tsx`,
      `${W}/components/runs/v3/BulkActionFilters.tsx`,
      `${W}/components/runs/v3/DeploymentStatus.tsx`,
      `${W}/components/deployments/DeploymentDialogs.tsx`,
      `${W}/components/RuntimeIcon.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${W}/components/UserProfilePhoto.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
    ],
  },
  concurrency: {
    description:
      "The Concurrency page in the dashboard, with Concurrency selected in the side menu under Observability. Three tiles at the top show the environment's queued runs (with a Pause Development environment button), running runs, and its concurrency limit of 25 with a burst limit of 50 and an Increase limit button. Below them are a Search queues field and a Show archived switch, then a table of queues with Name, Queued, Running, Limit and Limited by columns: process-image is at its limit of 5 and nightly-report is paused with a Resume button. Each row ends with a three-dot menu; the menu for sync-contacts is open, with Pause, View all runs, View queued runs, View running runs, Override limit… and Archive...",
    width: 1360,
    height: 700,
    marks: ["nav", "pause-env", "increase-limit", "show-archived", "row-menu", "archive"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.concurrency/route.tsx`,
      `${W}/components/queues/QueueControls.tsx`,
      `${W}/components/runs/v3/QueueName.tsx`,
      `${W}/components/metrics/BigNumber.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Popover.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
    ],
  },
  "deployments-not-promoted": {
    description:
      "The Deploys page in the dashboard, in Production. The newest deployment, version 20261125.2, is deployed but not current: the Current badge is on version 20261125.1 below it. Each row ends with a three-dot menu; the one on 20261125.2 has Promote.",
    width: 1200,
    height: 560,
    marks: ["nav", "current", "actions"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.deployments/route.tsx`,
      `${W}/components/runs/v3/DeploymentFilters.tsx`,
      `${W}/components/runs/v3/BulkActionFilters.tsx`,
      `${W}/components/runs/v3/DeploymentStatus.tsx`,
      `${W}/components/deployments/DeploymentDialogs.tsx`,
      `${W}/components/RuntimeIcon.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${W}/components/UserProfilePhoto.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
    ],
  },
  "deployments-row-menu": {
    description:
      "The Deploys page in the dashboard, in Production. The newest deployment, version 20261125.2, is deployed but not current: the Current badge is on version 20261125.1 below it. The three-dot menu at the end of the 20261125.2 row is open, with Promote and Redeploy.",
    width: 1200,
    height: 560,
    marks: ["nav", "current", "actions", "promote"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.deployments/route.tsx`,
      `${W}/components/runs/v3/DeploymentFilters.tsx`,
      `${W}/components/runs/v3/BulkActionFilters.tsx`,
      `${W}/components/runs/v3/DeploymentStatus.tsx`,
      `${W}/components/deployments/DeploymentDialogs.tsx`,
      `${W}/components/RuntimeIcon.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${W}/components/UserProfilePhoto.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Popover.tsx`,
    ],
  },
  "deployments-staging": {
    description:
      "The Deploys page in the dashboard with the Staging environment selected in the side menu. One deployment is listed, version 20261125.1, with a Current badge: Staging has its own versions and its own current deployment.",
    width: 1200,
    height: 560,
    marks: ["nav", "current"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.deployments/route.tsx`,
      `${W}/components/runs/v3/DeploymentFilters.tsx`,
      `${W}/components/runs/v3/BulkActionFilters.tsx`,
      `${W}/components/runs/v3/DeploymentStatus.tsx`,
      `${W}/components/deployments/DeploymentDialogs.tsx`,
      `${W}/components/RuntimeIcon.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${W}/components/UserProfilePhoto.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
    ],
  },
  "environment-variables": {
    description:
      "The Environment variables page in the dashboard, with Environment variables selected in the side menu under Security. A table lists each variable's key, masked value, environment (Development, Production) and when it was updated. Above it: a search field, environment filters, Reveal values, Compare, Needs attention and the Add new button.",
    width: 1200,
    height: 640,
    marks: ["nav", "add-new"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.environment-variables/route.tsx`,
      `${ROUTES}.environment-variables/EnvironmentVariableControls.tsx`,
      `${P}/Table.tsx`,
      `${P}/ClipboardField.tsx`,
    ],
  },
  "environment-variables-new": {
    description:
      "The New environment variables dialog. At the top, a checkbox button per environment (Development, Staging, Preview, Production), with Development and Production checked. Below: a Secret value switch, then rows of key and value fields (DATABASE_URL, STRIPE_SECRET_KEY, APP_URL) with Reveal switched on, a tip that you can paste a whole .env file into the form, an Add another button, and Cancel, Override and Save buttons.",
    width: 816,
    height: 570,
    marks: ["environments", "add-another", "save"],
    sources: [
      `${ROUTES}.environment-variables.new/route.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/Checkbox.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Buttons.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
    ],
  },
  "environment-variables-preview": {
    description:
      "The Environment variables page in the dashboard, filtered to Preview, with an All branches picker next to the environment filters. The table lists the Preview value of each key and the values set for single preview branches: DATABASE_URL has a Preview value and one for the feature/agents branch, OPENAI_API_KEY has secret values for both, and STRIPE_WEBHOOK_URL is set only for the fix/checkout branch. A branch's own value takes precedence over the Preview one.",
    width: 1200,
    height: 560,
    marks: ["nav", "branches", "add-new"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.environment-variables/route.tsx`,
      `${ROUTES}.environment-variables/EnvironmentVariableControls.tsx`,
      `${W}/v3/environmentVariables/environmentFilter.ts`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${P}/Table.tsx`,
      `${P}/ClipboardField.tsx`,
      `${P}/Select.tsx`,
    ],
  },
  "environment-variables-row-actions": {
    description:
      "The Environment variables page in the dashboard with the pointer over the DATABASE_URL row in Development. While a row is hovered, its right end shows two buttons: Edit (a pencil) and Delete (a trash can). A copy button also appears next to the key.",
    width: 1200,
    height: 640,
    marks: ["nav", "edit", "delete"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.environment-variables/route.tsx`,
      `${ROUTES}.environment-variables/EnvironmentVariableControls.tsx`,
      `${ROUTES}.environment-variables/CopyKeyButton.tsx`,
      `${P}/Table.tsx`,
      `${P}/ClipboardField.tsx`,
    ],
  },
  "github-connect-repo": {
    description:
      "The Connect GitHub repository dialog, opened with Connect GitHub repo in the project's Git settings. It has an Account select (acme) and a Repository select (hello-world). Under them: Configure repository access in GitHub, where GitHub is a link to the Trigger.dev app's repository access settings on GitHub. At the bottom, Cancel and Connect repository buttons.",
    width: 560,
    height: 380,
    marks: ["account", "repository", "github", "connect"],
    sources: [
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/Select.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/FormButtons.tsx`,
      `${P}/Hint.tsx`,
    ],
  },
  "metrics-dashboard": {
    description:
      "The built-in Run metrics dashboard in Production. Under the page title, the filter bar: Scope (Production), Tasks, Queues and the time period (1 day), with the Create custom dashboard button on the right. Four big-number widgets: Success % (87.2 %), Total runs (19,264), Failed runs (1,897) and Queued (0). Below them two charts over the last day, by hour: Run success %, a line chart of the completed (about 87%) and failed (about 10%) percentages with their averages, and Runs by status, a stacked bar chart of runs per hour with a legend that sums each status: Completed 16,790, Failed 1,897, Timed out 288, Canceled 235, Expired 49 and 2 more.",
    width: 1000,
    height: 771,
    marks: [
      "scope",
      "tasks",
      "queues",
      "period",
      "create",
      "big-numbers",
      "run-success",
      "runs-by-status",
    ],
    sources: [
      `${ROUTES}.dashboards.$dashboardKey/route.tsx`,
      `${W}/presenters/v3/BuiltInDashboards.server.ts`,
      `${W}/components/metrics/ScopeFilter.tsx`,
      `${W}/components/metrics/QueuesFilter.tsx`,
      `${W}/components/logs/LogsTaskFilter.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${W}/components/navigation/DashboardDialogs.tsx`,
      `${W}/components/metrics/QueryWidget.tsx`,
      `${W}/components/code/QueryResultsChart.tsx`,
      `${W}/components/code/chartColors.ts`,
      `${P}/charts/Card.tsx`,
      `${P}/charts/BigNumberCard.tsx`,
      `${P}/charts/ChartRoot.tsx`,
      `${P}/charts/ChartLine.tsx`,
      `${P}/charts/ChartBar.tsx`,
      `${P}/charts/ChartLegendCompound.tsx`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "preview-branches": {
    description:
      "The Preview branches page in the dashboard, with Preview branches selected in the side menu under Deployments. A table lists each branch (feature/agents, fix/retry-backoff, docs/onboarding) with when it was created, its last deployment, auto-archive, its git branch and commit, and whether it's archived; each row ends with a three-dot menu. Above it: a search field, Show archived and Auto-archive switches, and the New branch button at the top right. At the bottom: how many of your branches you've used.",
    width: 1440,
    height: 560,
    marks: ["nav", "new-branch"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.branches/route.tsx`,
      `${W}/routes/resources.branches.auto-archive.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${P}/Table.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
      `${P}/CopyableText.tsx`,
    ],
  },
  "preview-branches-new": {
    description:
      "The New branch dialog: a Branch name field, a hint listing what a name must not contain (spaces, ~, ^, :, ?, *, [, \\, //, .., @{ and .lock), and the Cancel and Create branch buttons.",
    width: 560,
    height: 263,
    marks: ["branch-name", "create"],
    sources: [
      `${W}/components/branches/NewBranchPanel.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/Input.tsx`,
      `${P}/Label.tsx`,
      `${P}/Hint.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/FormButtons.tsx`,
      `${W}/components/code/InlineCode.tsx`,
    ],
  },
  "preview-branches-row-menu": {
    description:
      "The Preview branches page in the dashboard with the three-dot menu at the end of the feature/agents row open. The menu has two items: Switch to branch and Archive branch.",
    width: 1440,
    height: 560,
    marks: ["actions", "archive"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.branches/route.tsx`,
      `${W}/routes/resources.branches.auto-archive.tsx`,
      `${W}/routes/resources.branches.archive.tsx`,
      `${W}/components/GitMetadata.tsx`,
      `${P}/Table.tsx`,
      `${P}/Popover.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/Switch.tsx`,
      `${P}/CopyableText.tsx`,
    ],
  },
  "project-settings-build": {
    description:
      "The Build settings section of the project's Integrations settings page. It applies to deployments triggered from GitHub and to CLI deployments run with the --native-build flag. Three fields: Trigger config file (empty, auto-detected; the placeholder is trigger.config.ts), Install command (empty, auto-detected) and Pre-build command, set to pnpm run prisma:generate. Each runs from the repo root. A Save button sits at the bottom right.",
    width: 640,
    height: 404,
    marks: ["config-file", "install", "pre-build"],
    sources: [
      `${ROUTES}.settings.integrations/route.tsx`,
      `${P}/SettingsLayout.tsx`,
      `${P}/Input.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "project-settings-git": {
    description:
      "The Git settings section of the project's Integrations settings page with a repository connected. Rows show the GitHub app as Installed and the GitHub repo as Connected, then the private repo acme/hello-world with a Disconnect button. A table of tracking branches follows, one row per environment with a Skip superseded switch: Production tracks main, Staging has no branch (none), and Preview has Deploy pull requests switched on. Pushes to a tracking branch deploy to its environment.",
    width: 640,
    height: 520,
    marks: ["disconnect", "prod", "staging", "preview"],
    sources: [
      `${ROUTES}.settings.integrations/route.tsx`,
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github.tsx`,
      `${P}/SettingsLayout.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Paragraph.tsx`,
      `${P}/TextLink.tsx`,
      `${P}/Buttons.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
    ],
  },
  query: {
    description:
      'The Query page in the dashboard, before a query has run. On the left, the query editor holds the default TRQL query (SELECT run_id, task_identifier, triggered_at, status FROM runs ORDER BY triggered_at DESC LIMIT 100) with syntax highlighting, and Format, Clear and Copy at its top right. Under it, the History button on the left (dimmed until a query has run), and Explain, the Scope filter (Development), the time period (7 days) and the Query button on the right. Below, the results panel has Table, Graph and Big number tabs (Graph and Big number dimmed) and says "Run a query to visualize the results." On the right, a help panel with AI, Writing TRQL, Table schema and Examples tabs: the AI tab has a box to describe a query in plain language, with New query and Edit query buttons, and example prompts such as "Show me failed runs by hour for the past 7 days".',
    width: 1000,
    height: 720,
    marks: ["history", "scope", "period", "query", "help", "ai"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/route.tsx`,
      `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/QueryHelpSidebar.tsx`,
      `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/AITabContent.tsx`,
      `${W}/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/QueryHistoryPopover.tsx`,
      `${W}/components/query/QueryEditor.tsx`,
      `${W}/components/code/TSQLEditor.tsx`,
      `${W}/components/code/AIQueryInput.tsx`,
      `${W}/components/code/codeMirrorTheme.ts`,
      `${W}/components/metrics/ScopeFilter.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/ShortcutKey.tsx`,
      `${P}/ClientTabs.tsx`,
      `${P}/Resizable.tsx`,
    ],
  },
  "replay-run": {
    description:
      "The Replay this run dialog in the dashboard, for a run in Development. Under a line saying that replaying creates a new run in the selected environment, the left side is a JSON editor with Payload and Metadata tabs (Payload is selected) showing the run's payload, with Clear and Copy buttons. The right side lists run options: Machine (small-1x), Version and Region (both disabled in Development), Queue (task/hello-world), Tags and Max attempts (3). At the bottom, Cancel is on the left, and on the right is Replay this run in, with an environment select set to Development, then the Replay run button.",
    width: 1024,
    height: 765,
    marks: ["payload", "environment", "replay"],
    sources: [
      `${W}/components/runs/v3/ReplayRunDialog.tsx`,
      `${W}/routes/resources.taskruns.$runParam.replay.ts`,
      `${W}/components/runs/v3/RunTagInput.tsx`,
      `${W}/components/code/JSONEditor.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${W}/utils/versionLabel.ts`,
      `${P}/Dialog.tsx`,
      `${P}/ModalCloseButton.tsx`,
      `${P}/Tabs.tsx`,
      `${P}/Resizable.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/ShortcutKey.tsx`,
      `${P}/Select.tsx`,
      `${P}/Input.tsx`,
      `${P}/Label.tsx`,
      `${P}/Hint.tsx`,
      `${P}/Paragraph.tsx`,
    ],
  },
  "run-detail": {
    description:
      "The run inspector on the Detail tab, for a completed child-task run. Below Status, Task, Run ID and Root & Parent run is the Idempotency section, with a Reset button at its right; it lists the key (welcome-email-user_123), the scope (run) and when the key expires. Debounce, Version, External deployment ID and SDK version follow.",
    width: 500,
    height: 560,
    marks: ["idempotency", "reset"],
    sources: [
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/versions/VersionLabel.tsx`,
      `${P}/PropertyTable.tsx`,
      `${P}/CopyableText.tsx`,
      `${P}/TextLink.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "run-error": {
    description:
      'The error shown in the run inspector for a run that exceeded its maxDuration: the heading MAX_DURATION_EXCEEDED in red, and below it an error callout with the message "Run exceeded maximum compute time (maxDuration) of 300 seconds".',
    width: 500,
    height: 114,
    marks: [],
    sources: [`${W}/components/runs/v3/RunError.tsx`, `${P}/Callout.tsx`, `${P}/Headers.tsx`],
  },
  "run-page": {
    description:
      'The run page for a finished hello-world run, in Development. At the top are the run ID, a Run docs button, and a toolbar with a log search box, Queue time and Errors only switches, and the Replay run button at the right. On the left is the trace: hello-world (Root, Completed), Attempt 1, run(), the log "Hello, world!", wait.for() 5 seconds and a warning, each with its bar or dot on the timeline beside it. On the right the inspector shows the run\'s Overview tab (the other tabs are Detail, Context and Metadata): Completed, the Triggered, Dequeued, Started and Finished times, the Payload and the Output.',
    width: 1216,
    height: 600,
    marks: ["replay"],
    sources: RUN_PAGE,
  },
  "run-page-metadata": {
    description:
      "The run page for a finished hello-world run with the inspector on the Metadata tab (the tabs are Overview, Detail, Context and Metadata). The tab shows the run's metadata as JSON: a user object with a name and an id, and progress set to 1. The trace and its timeline are on the left.",
    width: 1216,
    height: 600,
    marks: ["metadata"],
    sources: RUN_PAGE,
  },
  "run-page-span": {
    description:
      'The run page for a finished fetch-todos run with a GET span selected. The trace shows fetch-todos (Root, Completed), Attempt 1 and run(), then two GET spans recorded automatically for the run\'s HTTP requests and the log "Fetched todo", each with its bar or dot on the timeline. On the right the span inspector for the selected GET shows Completed, its Started and Finished times (147 milliseconds apart), the Message (GET) with a Copy link, and the Properties as JSON: the request method, the response status code 200, the URL and the server address and port.',
    width: 1216,
    height: 600,
    marks: [],
    sources: RUN_PAGE,
  },
  "run-resource-monitor": {
    description:
      'The run page for a finished resource-monitor-test run with one of its ResourceMonitor logs selected. The trace lists the run, Attempt 1 and run(), then one ResourceMonitor log per second, each starting "ResourceMonitor | Disk: 0.0% [OK] | Mem: 36.1% [OK] | Node:11.7% [OK]". On the right the log inspector shows its Timestamp, the full Message ("ResourceMonitor | Disk:  0.0% [OK] | Mem: 36.1% [OK] | Node:11.7% [OK] | Heap: 7.3% [OK] | GC: 4( 1.9ms) [OK] | [1CPU/1GB]": disk, system memory, Node memory and heap usage, garbage collection and the machine size) with a Copy link, and the Properties as JSON, starting with the garbage collection stats.',
    width: 1216,
    height: 600,
    marks: [],
    sources: RUN_PAGE,
  },
  "run-resource-monitor-ffmpeg": {
    description:
      'The same run page with a ResourceMonitor log selected, for a task that monitors an ffmpeg child process. Each log now has an ffmpeg part after Heap with the CPU and memory usage of the ffmpeg process; the selected Message is "ResourceMonitor | Disk:  0.0% [OK] | Mem: 36.1% [OK] | Node:11.7% [OK] | Heap: 7.3% [OK] | ffmpeg:95.8% [CRIT]/46.1% [OK] | GC: 4( 1.9ms) [OK] | [1CPU/1GB]". The Properties JSON below it holds the full snapshot.',
    width: 1216,
    height: 600,
    marks: [],
    sources: RUN_PAGE,
  },
  "run-trace": {
    description:
      'The trace of a finished parent-task run on the run page: the span tree on the left and the timeline on the right, with a duration scale along the top (0ms to 19.3s). Under parent-task (Root, Completed) are Attempt 1 and run(), then the run\'s logs: "Parent task payload", a warning "You\'ve been warned", "This is the parent task context", "This is an info message" and an error "This is an error message", each a dot on the timeline. Then wait.for() 6 seconds, and triggerAndWait() child-task with the child-task run nested inside it (Completed, its own Attempt 1, run(), a log, wait.for() 10 seconds and "Child task finished"). Last come the log "Child task response" and a trigger() span. Spans are bars on the timeline labelled with their durations.',
    width: 1000,
    height: 608,
    marks: [],
    sources: [
      `${W}/components/runs/v3/trace/TasksTreeView.tsx`,
      `${W}/components/runs/v3/trace/TimelineView.tsx`,
      `${W}/components/runs/v3/RunIcon.tsx`,
      `${W}/components/runs/v3/SpanTitle.tsx`,
      `${P}/Resizable.tsx`,
    ],
  },
  "run-trace-instrumented": {
    description:
      "The trace of a finished convert-video run on the run page: the span tree on the left and the timeline on the right (0ms to 7.4s). Under convert-video (Root, Completed), Attempt 1 and run() are three triggerAndWait() spans. The first, for process-video, contains the process-video run: inside its run() are spans from the Prisma instrumentation (prisma:client:operation with prisma:client:serialize, prisma:client:connect and prisma:engine), a GET request and an ffmpeg span, followed by store.uploadOutput; the parent then downloads the output (store.downloadPayload). The second, for upload-to-s3, contains that run with an S3.PutObject span from the AWS SDK instrumentation. Last come a collapsed prisma:client:operation (the database update) and a collapsed triggerAndWait() for send-user-email.",
    width: 1000,
    height: 736,
    marks: [],
    sources: [
      `${W}/components/runs/v3/trace/TasksTreeView.tsx`,
      `${W}/components/runs/v3/trace/TimelineView.tsx`,
      `${W}/components/runs/v3/RunIcon.tsx`,
      `${W}/components/runs/v3/SpanTitle.tsx`,
      `${P}/Resizable.tsx`,
    ],
  },
  "runs-list": {
    description:
      'The Runs page in the dashboard, in Development. Under the page title are the filters: a "Describe your filters" box, Status, Tasks, "Created: 7 days", a "Root only" switch and More filters. On the right of the same row are the Bulk action and Columns buttons and the previous and next page arrows. Below is the runs table. Each row is a run, with a checkbox and columns for ID, Task, Status, Version, Started, Duration, Compute, Machine and Queue; more columns continue past the right edge. At the right end of every row is the run\'s action button, a vertical three-dot menu. The example rows are hello-world and child-task runs: most Completed, one Failed, one Delayed (no version or machine yet, with a "Delayed until" time) and one Expired (it waited 10 minutes, its TTL, and never started).',
    width: 1213,
    height: 459,
    marks: ["actions", "bulk-action", "more-filters", "status-delayed", "status-expired"],
    sources: [
      `${ROUTES}.runs._index/route.tsx`,
      `${W}/components/runs/v3/RunFilters.tsx`,
      `${W}/components/runs/v3/AIFilterInput.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${W}/components/runs/v3/RunsDisplayOptions.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/runColumns.ts`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/runs/v3/TaskTriggerSource.tsx`,
      `${W}/components/runs/v3/LiveTimer.tsx`,
      `${W}/components/versions/VersionLabel.tsx`,
      `${W}/components/MachineLabelCombo.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Select.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Checkbox.tsx`,
      `${P}/Popover.tsx`,
      `${P}/Tooltip.tsx`,
      `${P}/TruncatedCopyableValue.tsx`,
    ],
  },
  "runs-list-filter-tags": {
    description:
      'The Runs page in the dashboard, in Development, filtering by tags. Under More filters, in the row of filters above the runs table, a dropdown is open with a search box at the top where "org:acme" has been typed. Below it are the matching tags: org:acme_123 (highlighted), org:acme_456, org:acme_789 and org:acme_901.',
    width: 1213,
    height: 459,
    marks: ["more-filters", "tags"],
    sources: [
      `${ROUTES}.runs._index/route.tsx`,
      `${W}/components/runs/v3/RunFilters.tsx`,
      `${W}/components/runs/v3/AIFilterInput.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${W}/components/runs/v3/RunsDisplayOptions.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/MachineLabelCombo.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${P}/Select.tsx`,
      `${P}/Table.tsx`,
    ],
  },
  "runs-list-row-menu": {
    description:
      "The Runs page in the dashboard, in Development, with one run's action menu open in the runs table. The menu belongs to a Failed hello-world run and drops down below the run's vertical three-dot button at the right end of its row. It has two items: View run, with an arrow icon, and Replay run…, with a circular arrows icon.",
    width: 1213,
    height: 459,
    marks: ["actions", "replay"],
    sources: [
      `${ROUTES}.runs._index/route.tsx`,
      `${W}/components/runs/v3/RunFilters.tsx`,
      `${W}/components/runs/v3/AIFilterInput.tsx`,
      `${W}/components/runs/v3/SharedFilters.tsx`,
      `${W}/components/runs/v3/RunsDisplayOptions.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Input.tsx`,
      `${P}/Switch.tsx`,
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/runColumns.ts`,
      `${W}/components/runs/v3/TaskRunStatus.tsx`,
      `${W}/components/runs/v3/LiveTimer.tsx`,
      `${W}/components/versions/VersionLabel.tsx`,
      `${W}/components/MachineLabelCombo.tsx`,
      `${P}/Table.tsx`,
      `${P}/Popover.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Checkbox.tsx`,
    ],
  },
  "runs-list-tags": {
    description:
      "The Tags column of the runs table in the dashboard. Each tag is drawn as a label with a notch on its left. Tags with a prefix show the prefix and the value in separate parts: org and acme_123, user and user_456.",
    width: 320,
    height: 106,
    marks: [],
    sources: [
      `${W}/components/runs/v3/TaskRunsTable.tsx`,
      `${W}/components/runs/v3/RunTag.tsx`,
      `${P}/Table.tsx`,
    ],
  },
  schedules: {
    description:
      "A scheduled task's page in the dashboard, for first-scheduled-task. The header shows a clock icon, the task's name, \"Scheduled task\", its version and how many runs are running and queued, with Watch, View runs and Test task buttons on the right. Below are the Runs, Queue and Schedules tabs; Schedules is open. It has a Create schedule button and a table with one imperative schedule: cron 0 9 * * * in UTC, the next run tomorrow at 9:00, enabled. A bar at the bottom reads \"You've used 1/10 of your schedules\" with an Upgrade button. On the right, a rail lists the task's details and execution settings.",
    width: 1120,
    height: 520,
    marks: ["test-task", "schedules-tab", "create-schedule"],
    sources: [
      `${ROUTES}.tasks.scheduled.$taskParam/route.tsx`,
      `${W}/components/tasks/TaskDetailView.tsx`,
      `${P}/detail/DetailPage.tsx`,
      `${P}/detail/DetailSections.tsx`,
      `${P}/BreadcrumbIcon.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Table.tsx`,
      `${P}/Resizable.tsx`,
      `${W}/components/schedules/SchedulesUsageBar.tsx`,
      `${W}/components/schedules/ScheduleLimitActions.tsx`,
      `${W}/components/runs/v3/ScheduleType.tsx`,
      `${W}/components/runs/v3/EnabledStatus.tsx`,
    ],
  },
  "schedules-new": {
    description:
      'The New schedule dialog, titled "New schedule for first-scheduled-task", opened with the Create schedule button on a scheduled task\'s page. On the left: a "Describe your schedule using natural language" box with a Generate button, the CRON pattern (UTC) field containing 0 9 * * * with "Valid pattern: At 09:00 AM." under it, Timezone (UTC), an optional Window, the Environment (Development), an optional External ID and an optional Deduplication key. On the right, "Next 5 runs" lists the next five runs at 9:00 am on consecutive days. Cancel and Create schedule buttons are at the bottom.',
    width: 768,
    height: 757,
    marks: ["generate", "cron", "timezone", "window", "external-id", "next-runs", "create"],
    sources: [
      `${W}/components/schedules/ScheduleViews.tsx`,
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route.tsx`,
      `${W}/routes/resources.orgs.$organizationSlug.projects.$projectParam.schedules.new.natural-language.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/Input.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Label.tsx`,
      `${P}/Hint.tsx`,
      `${P}/Select.tsx`,
      `${P}/Buttons.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
    ],
  },
  "tasks-list": {
    description:
      "The Tasks page in the dashboard, in Development, with Tasks selected at the top of the side menu. Above the list: a Search tasks field, a filter for the task type (All, then icons for agent, standard, scheduled (a clock) and webhook tasks) and the New task button. The table lists each task's ID with its type icon, its Type (Standard or Scheduled), File, Running count and a 24-hour activity chart. The example tasks are child-task, create-embedding-for-post, first-scheduled-task (Scheduled), hello-world and parent-task.",
    width: 1200,
    height: 340,
    marks: ["nav", "scheduled-filter", "new-task", "scheduled-task"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}._index/route.tsx`,
      `${W}/components/runs/v3/TaskTriggerSource.tsx`,
      `${W}/components/runs/v3/TaskPath.tsx`,
      `${W}/components/code/InlineCode.tsx`,
      `${W}/components/tasks/TaskActivityGraphChart.tsx`,
      `${W}/components/metrics/ActivityBarChart.tsx`,
      `${W}/components/metrics/ActivityBarChartBlankState.tsx`,
      `${P}/SearchInput.tsx`,
      `${P}/SegmentedControl.tsx`,
      `${P}/Table.tsx`,
    ],
  },
  "test-scheduled-task": {
    description:
      "A scheduled task's test page in the dashboard, for first-scheduled-task in Development. Under the task's name are the schedule payload fields: Timestamp UTC (2026/11/25, 09:00:00 AM) with a Now button, Last timestamp UTC (2026/11/24, 09:00:00 AM) with Now and Clear, Timezone (UTC) and an empty External ID. Below a divider are the run options, starting with Machine (small-1x), with more further down the page. Templates and Recent runs are at the top right. At the bottom: \"This test will run in Development\", a button to save a template and the Run test button.",
    width: 820,
    height: 680,
    marks: ["payload", "templates", "recent-runs", "run-test"],
    sources: [
      `${ROUTES}.test/route.tsx`,
      `${ROUTES}.test.tasks.$taskParam/route.tsx`,
      `${W}/components/runs/v3/TaskTriggerSource.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Fieldset.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Label.tsx`,
      `${P}/Hint.tsx`,
      `${P}/DateField.tsx`,
      `${P}/Input.tsx`,
      `${P}/Select.tsx`,
      `${P}/Buttons.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${W}/utils/versionLabel.ts`,
    ],
  },
  "api-keys-new": {
    description:
      "The New API key dialog for the Development environment with Access switched from Preset to Custom, scrolled to the Access section. Above the grid are the Start from and Add preset selects, Clear all and Save as preset. The Tasks area is set to Read & trigger for all tasks, and a grid gives every other area (Runs, Batches, Large payloads, Queues, Sessions, Input streams, Tagged runs, Errors, Webhooks, Waitpoints, Prompts, Deployments, Preview branches, Env vars) a radio button for None, Read, Write, Read & write or Manage, set here to Operator plus Deploy only. A summary panel on the right lists each area's level and the scopes it grants, and the footer has Cancel and Create API key.",
    width: 992,
    height: 720,
    marks: [
      "custom",
      "start-from",
      "add-preset",
      "clear-all",
      "save-preset",
      "tasks",
      "task-access",
      "grid",
      "summary",
      "create",
    ],
    sources: [
      `${ROUTES}.apikeys/NewApiKeyDialog.tsx`,
      `${ROUTES}.apikeys/ApiKeyAccessPicker.tsx`,
      `${ROUTES}.apikeys/ApiKeyCapabilities.tsx`,
      `${W}/components/environments/EnvironmentLabel.tsx`,
      `${W}/assets/icons/DropdownIcon.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/SegmentedControl.tsx`,
      `${P}/RadioButton.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "test-task": {
    description:
      'A task\'s test page in the dashboard, for the hello-world task in Development. Top right: Templates and Recent runs. On the left, a JSON editor with Payload and Metadata tabs holds the payload { "name": "Acme" }. On the right, the Options tab sets the machine, version, region and queue (more options below), next to AI and Schema tabs. At the bottom: "This test will run in Development", a button to save a template and the Run test button.',
    width: 1000,
    height: 600,
    marks: ["templates", "recent-runs", "payload", "options", "run-test"],
    sources: [
      `${ROUTES}.test/route.tsx`,
      `${ROUTES}.test.tasks.$taskParam/route.tsx`,
      `${ROUTES}.test.tasks.$taskParam/TestSidebarTabs.tsx`,
      `${W}/components/code/JSONEditor.tsx`,
      `${W}/components/code/codeMirrorTheme.ts`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Select.tsx`,
      `${P}/Tabs.tsx`,
      `${P}/ClientTabs.tsx`,
      `${P}/Label.tsx`,
      `${W}/utils/versionLabel.ts`,
    ],
  },
  usage: {
    description:
      "The organization's Usage page in the dashboard, for the current month (November 2026, picked in the month menu at the top left). The first card shows the month-to-date spend ($25.62) with the Update billing limit button on the right, and a usage bar marked with what has been used ($25.62), the plan's included usage ($50.00) and a Billing limit marker ($100.00). Below it, Usage by day is a bar chart of each day's spend this month. At the bottom, the Tasks table lists each task's runs, average duration, average cost, total duration and total cost, most expensive first (process-image, generate-report, sync-data, send-email, hello-world, cleanup-uploads), with a note that Dev environment runs are excluded.",
    width: 1000,
    height: 967,
    marks: ["month", "month-to-date", "update-limit", "limit-marker", "usage-by-day", "tasks"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.settings.usage/route.tsx`,
      `${W}/components/billing/UsageBar.tsx`,
      `${W}/components/layout/MetricsLayout.tsx`,
      `${P}/charts/Card.tsx`,
      `${P}/charts/ChartRoot.tsx`,
      `${P}/charts/ChartBar.tsx`,
      `${P}/Table.tsx`,
      `${P}/Select.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  webhooks: {
    description:
      "The Webhooks page in the dashboard, with Webhooks selected in the side menu. Above the table are Status, Subscriber and Source filters and a search field. The table lists the environment's endpoints with Endpoint, Source, Status, URL, Signing secret, Activity (24h), Last delivery and AI setup columns. The github endpoint's Signing secret column says Needs secret and it has no deliveries; the payments (stripe) and support-inbox (slack) endpoints say Ready and show their recent deliveries. Each row ends with a Copy setup prompt button.",
    width: 1480,
    height: 360,
    marks: ["nav", "endpoint", "signing-secret", "setup-prompt"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.webhooks._index/route.tsx`,
      `${W}/components/webhookEndpoints/v1/EndpointsListTable.tsx`,
      `${W}/components/webhookEndpoints/v1/EndpointFilters.tsx`,
      `${W}/components/webhookEndpoints/v1/CopySetupPromptButton.tsx`,
      `${W}/components/metrics/ActivityBarChart.tsx`,
      `${W}/components/ListPagination.tsx`,
      `${P}/Table.tsx`,
      `${P}/CopyableText.tsx`,
      `${P}/SearchInput.tsx`,
    ],
  },
  "webhook-endpoint-settings": {
    description:
      'The github webhook endpoint\'s page in the dashboard, with the Settings tab open. The header shows the endpoint\'s name, Active, "Source github", "Default tenant" and "No deliveries in this period", with Copy setup prompt and Send test event buttons. Below are the Deliveries, Subscribers, Waiters, Test and Settings tabs. Under Connect, the Webhook URL row shows the endpoint\'s URL, and the Signing secret row says Needs signing secret with Set signing secret and Generate secret buttons. Under Verification are the github scheme (hmac), the x-hub-signature-256 header, the sha256 / hex algorithm and the raw body signing string; under Danger zone, Disable endpoint. On the right, a rail lists the endpoint\'s details, its Webhook URL and signing secret state, and its signature scheme.',
    width: 1280,
    height: 660,
    marks: ["settings-tab", "webhook-url", "set-secret", "generate-secret"],
    sources: [
      `${ROUTES}.webhooks.endpoints.$endpointParam/route.tsx`,
      `${W}/components/webhookEndpoints/v1/EndpointStatus.tsx`,
      `${W}/components/webhookEndpoints/v1/CopySetupPromptButton.tsx`,
      `${P}/detail/DetailPage.tsx`,
      `${P}/detail/DetailSections.tsx`,
      `${P}/BreadcrumbIcon.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/CopyableText.tsx`,
      `${P}/Resizable.tsx`,
      `${W}/routes/storybook.detail-pages/route.tsx`,
    ],
  },
  "webhook-endpoint-test": {
    description:
      "The github webhook endpoint's page in the dashboard, with the Test tab open. On the left is the event body editor (Body, Library and Replay tabs) holding a sample JSON body with a message field. On the right are the Signature option set to Signed (valid), Headers with one row, x-github-event set to push, and an Add header button, and the POST Webhook URL. A bar at the bottom reads \"Signs with the endpoint's secret and runs the full delivery pipeline.\" with a Send event button. The rail on the right shows the signing secret as Ready.",
    width: 1280,
    height: 560,
    marks: ["test-tab", "headers", "send-event", "deliveries-tab"],
    sources: [
      `${ROUTES}.webhooks.endpoints.$endpointParam/route.tsx`,
      `${W}/components/webhookEndpoints/v1/EndpointStatus.tsx`,
      `${W}/components/webhookEndpoints/v1/CopySetupPromptButton.tsx`,
      `${P}/detail/DetailPage.tsx`,
      `${P}/detail/DetailSections.tsx`,
      `${P}/BreadcrumbIcon.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/CopyableText.tsx`,
      `${P}/Resizable.tsx`,
      `${W}/routes/storybook.detail-pages/route.tsx`,
      `${W}/components/webhookConsole/WebhookComposer.tsx`,
      `${W}/components/code/JSONEditor.tsx`,
      `${P}/Tabs.tsx`,
      `${P}/Input.tsx`,
      `${P}/Select.tsx`,
    ],
  },
  "webhook-delivery": {
    description:
      'A test delivery to the github endpoint in the dashboard, with the Targets tab open. The header shows the delivery\'s ID with a Test badge and Succeeded, "On github", when it arrived and "Processed in 84ms", with View run and Replay buttons. Below are the Event, Headers and Targets tabs. The Targets table has one row: the github-events target, type Task, status Succeeded, detail None, and a link to the run it started. On the right, a rail shows the timeline (Received, 84ms of routing, Delivered, then the run) and the delivery\'s status, endpoint and run.',
    width: 1180,
    height: 520,
    marks: ["targets-tab", "target", "target-run", "view-run"],
    sources: [
      `${ROUTES}.webhooks.deliveries.$deliveryParam/route.tsx`,
      `${W}/components/webhookDeliveries/v1/DeliveryTargetsTable.tsx`,
      `${W}/components/webhookDeliveries/v1/DeliveryTimeline.tsx`,
      `${W}/components/webhookDeliveries/v1/buildDeliveryTimelineItems.ts`,
      `${W}/components/webhookDeliveries/v1/DeliveryStatus.tsx`,
      `${W}/components/run/RunTimeline.tsx`,
      `${P}/detail/DetailPage.tsx`,
      `${P}/detail/DetailSections.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Buttons.tsx`,
      `${P}/Table.tsx`,
      `${P}/TextLink.tsx`,
    ],
  },
  regions: {
    description:
      "The Regions page in the dashboard, with Regions selected in the side menu. The table has Region, Cloud Provider, Location, Static IPs and Default region columns. It lists eu-central-1 (Europe, Frankfurt), us-east-1 (US East, N. Virginia), which has the Default badge, and us-east-1-next (US East, N. Virginia), which has a MicroVM badge. All three run on Amazon Web Services and show an Unlock static IPs button. The us-east-1-next row is hovered, showing its Set as default… button. Below are Suggest a new region and a Suggest a region… button, and a note that Trigger.dev is GDPR compliant.",
    width: 1180,
    height: 540,
    marks: ["nav", "microvm", "set-default"],
    sources: [
      ...APP_FRAME,
      `${ROUTES}.regions/route.tsx`,
      `${W}/presenters/v3/RegionsPresenter.server.ts`,
      `${W}/assets/icons/CloudProviderIcon.tsx`,
      `${W}/assets/icons/RegionIcons.tsx`,
      `${P}/Table.tsx`,
      `${P}/Badge.tsx`,
      `${P}/InfoPanel.tsx`,
    ],
  },
  "private-connections": {
    description:
      "The organization's Private Connections settings page in the dashboard, with Private connection docs and Add Connection buttons at the top. Below the intro are two connection cards. Acme database is ACTIVE: its Service is com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0, its Region us-east-1, and its IPs 10.0.12.34, with a copy button. Redis cache is PROVISIONING and has no IPs yet. Each card has a delete button and its created date; an Add Connection button sits below the cards.",
    width: 900,
    height: 540,
    marks: ["add-connection", "status", "assigned-ip"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.settings.private-connections._index/route.tsx`,
      `${W}/components/layout/AppLayout.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Paragraph.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "private-connections-new": {
    description:
      "The Add Private Connection page in the dashboard. Four setup cards: I have my details (selected), Set up with AI, Set up with Terraform and Step-by-step guide. Below, a panel asks you to add the AWS account ARN arn:aws:iam::123456789012:root to your VPC Endpoint Service's allowed principals, with a copy button. The Connection Details form has Friendly name (Acme database), VPC Endpoint Service name (com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0) and Target region (us-east-1, with the note that your tasks have recently run in us-east-1), then Cancel and Create Connection buttons.",
    width: 900,
    height: 840,
    marks: ["details-card", "account-arn", "service-name", "target-region", "create"],
    sources: [
      `${W}/routes/_app.orgs.$organizationSlug.settings.private-connections.new/route.tsx`,
      `${W}/components/layout/AppLayout.tsx`,
      `${P}/PageHeader.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Paragraph.tsx`,
      `${P}/ClipboardField.tsx`,
      `${P}/CopyButton.tsx`,
      `${P}/Label.tsx`,
      `${P}/Input.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Fieldset.tsx`,
      `${P}/FormButtons.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
  "prompt-override": {
    description:
      'The Create override dialog on the customer-support prompt\'s page. On the left, an editor with a Copy button holds the prompt template: "You are a support agent for Acme SaaS.", a Customer context section with {{customerName}}, {{plan}} and {{issue}}, and the edited last line "Respond to the customer\'s issue in two sentences or fewer." On the right, under Override settings, Commit message is "Shorter replies" and Model is gpt-6-luna, with the hint "Override the default model for this version"; below, Variables (from code) lists customerName, plan and issue, each a required string. At the bottom are Cancel and Create override buttons.',
    width: 1040,
    height: 520,
    marks: ["template", "commit-message", "model", "create"],
    sources: [
      `${ROUTES}.prompts.$promptSlug/route.tsx`,
      `${W}/components/code/TextEditor.tsx`,
      `${P}/Dialog.tsx`,
      `${P}/Headers.tsx`,
      `${P}/Label.tsx`,
      `${P}/Input.tsx`,
      `${P}/InputGroup.tsx`,
      `${P}/Hint.tsx`,
      `${P}/Badge.tsx`,
      `${P}/Buttons.tsx`,
    ],
  },
} as const satisfies Record<string, DashboardFigureMeta>;

export type DashboardFigureName = keyof typeof dashboardFigures;

export function getDashboardFigure(name: string): DashboardFigureMeta | undefined {
  return Object.hasOwn(dashboardFigures, name)
    ? dashboardFigures[name as DashboardFigureName]
    : undefined;
}

type FigureHighlight = { mark: string; label?: string };

const HIGHLIGHT_ITEM = /^([a-z0-9-]+)(?::([A-Za-z0-9 .-]{1,12}))?$/;

/**
 * `highlight="nav:1, add-new:2"`: ring each mark, with the text after the colon as its badge.
 * Throws on a malformed item or a mark the figure doesn't have, so a typo fails the build.
 */
export function parseHighlight(name: string, value: string | undefined): FigureHighlight[] {
  if (!value?.trim()) return [];
  const meta = getDashboardFigure(name);
  return value.split(",").map((raw) => {
    const m = HIGHLIGHT_ITEM.exec(raw.trim());
    if (!m) throw new Error(`<DashboardFigure name="${name}">: bad highlight item "${raw.trim()}"`);
    if (!meta?.marks.includes(m[1]!)) {
      throw new Error(
        `<DashboardFigure name="${name}">: no mark "${m[1]}" (marks: ${meta?.marks.join(", ") || "none"})`
      );
    }
    return { mark: m[1]!, label: m[2]?.trim() || undefined };
  });
}

/** Every `<DashboardFigure ... />` tag in MDX: string attributes only, always self-closing. */
export const DASHBOARD_FIGURE_TAG =
  /<DashboardFigure((?:\s+[A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/>/g;

export function figureTagAttrs(attrs: string): Record<string, string> {
  return Object.fromEntries(
    [...attrs.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1],
      m[2] ?? m[3],
    ])
  );
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");
const INLINE_CODE = /`[^`\n]+`/g;

/** MDX with fenced code blanked, line by line. A fence closes only at its own blockquote depth,
 * and a quoted fence also ends with its quote (CommonMark's container rule). Fence markers inside
 * a multiline MDX comment are comment text, left for the comment pass. */
function blankFences(mdx: string): string {
  let open: { marker: string; depth: number } | undefined;
  let comment = false;
  // A line leaves an MDX comment open when its last `{/*` comes after its last `*/` (the comment
  // ends there; the expression's `}` may follow on a later line). Inline code doesn't count.
  const opensComment = (line: string) => {
    const text = line.replace(INLINE_CODE, "");
    const start = Math.max(...[...text.matchAll(/\{\s*\/\*/g)].map((m) => m.index), -1);
    return start > text.lastIndexOf("*/");
  };
  return mdx
    .split("\n")
    .map((line) => {
      if (comment) {
        // Markdown doesn't apply inside a comment: find its end first, then read what follows.
        const end = line.indexOf("*/");
        comment = end === -1 || opensComment(line.slice(end + 2));
        return line;
      }
      // `[^\n]*`, not `.*`: a CRLF file leaves `\r` at the end of each line.
      const m = /^[ \t]*((?:>[ \t]?)*)[ \t]*(`{3,}|~{3,})([^\n]*)$/.exec(line);
      const depth = (/^[ \t]*((?:>[ \t]?)*)/.exec(line)![1]!.match(/>/g) ?? []).length;
      if (open && depth < open.depth) open = undefined;
      else if (open) {
        const closes =
          m &&
          depth === open.depth &&
          m[2]![0] === open.marker[0] &&
          m[2]!.length >= open.marker.length &&
          !m[3]!.trim();
        if (closes) open = undefined;
        return blank(line);
      }
      if (!m) {
        comment = opensComment(line);
        return line;
      }
      open = { marker: m[2]!, depth };
      return blank(line);
    })
    .join("\n");
}

/** The figure tags MDX renders: where each starts in `mdx`, its text and its attributes. */
export function figureTags(mdx: string) {
  // Examples don't count: fenced code, inline code and MDX comments are blanked to the same length,
  // so a match's index points into `mdx`. The mask only finds the tags: their text and attributes
  // come from `mdx` (a caption may hold `code`).
  const masked = blankFences(mdx).replace(/`[^`\n]+`|\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank);
  return [...masked.matchAll(DASHBOARD_FIGURE_TAG)].map((m) => {
    const tag = mdx.slice(m.index, m.index + m[0].length);
    return { index: m.index, tag, attrs: figureTagAttrs(tag) };
  });
}

/** "1: nav, 2: add new": which mark each numbered badge is on, for screen readers and agents. */
export function badgeText(marks: FigureHighlight[]): string {
  return marks
    .filter((m) => m.label)
    .map((m) => `${m.label}: ${m.mark.replaceAll("-", " ")}`)
    .join(", ");
}

/** The highlight as one canonical line, for the figure's data attribute and CSS selector. */
export const highlightKey = (marks: FigureHighlight[]) =>
  marks.map((m) => (m.label ? `${m.mark}:${m.label}` : m.mark)).join(",");

/** The markdown agents get: each figure as `[Dashboard: <description>]`, then its caption. */
export function expandDashboardFigures(markdown: string): string {
  let out = "";
  let last = 0;
  for (const { index, tag, attrs } of figureTags(markdown)) {
    const { name = "", caption, highlight } = attrs;
    const meta = getDashboardFigure(name);
    if (!meta) continue;
    const badges = badgeText(parseHighlight(name, highlight));
    out += markdown.slice(last, index);
    out += `[Dashboard: ${meta.description}${badges ? ` Marked ${badges}.` : ""}]`;
    out += caption ? `\n\n${caption}` : "";
    last = index + tag.length;
  }
  return out + markdown.slice(last);
}
