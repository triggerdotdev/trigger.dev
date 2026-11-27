import type { ComponentType } from "react";
import type { DashboardFigureName } from "@/lib/dashboard-figures";
import { AlertsFigure } from "./alerts";
import { AlertsEmptyFigure } from "./alerts-empty";
import { AlertsNewFigure } from "./alerts-new";
import { ApiKeysFigure } from "./api-keys";
import { ApiKeysNewFigure } from "./api-keys-new";
import { BillingAlertsFigure } from "./billing-alerts";
import { BillingLimitFigure } from "./billing-limit";
import { BulkActionCreateFigure } from "./bulk-action-create";
import { BulkActionsFigure } from "./bulk-actions";
import { ConcurrencyFigure } from "./concurrency";
import {
  DeploymentsFigure,
  DeploymentsNotPromotedFigure,
  DeploymentsRowMenuFigure,
  DeploymentsStagingFigure,
} from "./deployments";
import {
  EnvironmentVariablesFigure,
  EnvironmentVariablesPreviewFigure,
  EnvironmentVariablesRowActionsFigure,
} from "./environment-variables";
import { EnvironmentVariablesNewFigure } from "./environment-variables-new";
import { GitHubConnectRepoFigure } from "./github-connect-repo";
import { MetricsDashboardFigure } from "./metrics-dashboard";
import { PreviewBranchesFigure, PreviewBranchesRowMenuFigure } from "./preview-branches";
import { PreviewBranchesNewFigure } from "./preview-branches-new";
import { ProjectSettingsBuildFigure, ProjectSettingsGitFigure } from "./project-settings";
import { QueryFigure } from "./query";
import { ReplayRunFigure } from "./replay-run";
import { RunDetailFigure } from "./run-detail";
import { RunErrorFigure } from "./run-error";
import { RunPageFigure } from "./run-page";
import { RunPageMetadataFigure } from "./run-page-metadata";
import { RunPageSpanFigure } from "./run-page-span";
import { RunResourceMonitorFfmpegFigure, RunResourceMonitorFigure } from "./run-resource-monitor";
import { RunTraceFigure } from "./run-trace";
import { RunTraceInstrumentedFigure } from "./run-trace-instrumented";
import { RunsListFigure } from "./runs-list";
import { RunsListFilterTagsFigure } from "./runs-list-filter-tags";
import { RunsListRowMenuFigure } from "./runs-list-row-menu";
import { RunsListTagsFigure } from "./runs-list-tags";
import { SchedulesFigure } from "./schedules";
import { SchedulesNewFigure } from "./schedules-new";
import { TasksListFigure } from "./tasks-list";
import { TestScheduledTaskFigure } from "./test-scheduled-task";
import { TestTaskFigure } from "./test-task";
import { UsageFigure } from "./usage";
import { WebhooksFigure } from "./webhooks";
import { WebhookDeliveryFigure } from "./webhook-delivery";
import { RegionsFigure } from "./regions";
import { PrivateConnectionsFigure, PrivateConnectionsNewFigure } from "./private-connections";
import { PromptOverrideFigure } from "./prompt-override";
import { WebhookEndpointSettingsFigure, WebhookEndpointTestFigure } from "./webhook-endpoint";

/** Each registry entry (lib/dashboard-figures.ts) and the component that draws it. */
export const figureComponents: Record<DashboardFigureName, ComponentType> = {
  alerts: AlertsFigure,
  "alerts-empty": AlertsEmptyFigure,
  "alerts-new": AlertsNewFigure,
  "api-keys": ApiKeysFigure,
  "api-keys-new": ApiKeysNewFigure,
  "billing-alerts": BillingAlertsFigure,
  "billing-limit": BillingLimitFigure,
  "bulk-action-create": BulkActionCreateFigure,
  "bulk-actions": BulkActionsFigure,
  concurrency: ConcurrencyFigure,
  deployments: DeploymentsFigure,
  "deployments-not-promoted": DeploymentsNotPromotedFigure,
  "deployments-row-menu": DeploymentsRowMenuFigure,
  "deployments-staging": DeploymentsStagingFigure,
  "environment-variables": EnvironmentVariablesFigure,
  "environment-variables-new": EnvironmentVariablesNewFigure,
  "environment-variables-preview": EnvironmentVariablesPreviewFigure,
  "environment-variables-row-actions": EnvironmentVariablesRowActionsFigure,
  "github-connect-repo": GitHubConnectRepoFigure,
  "metrics-dashboard": MetricsDashboardFigure,
  "preview-branches": PreviewBranchesFigure,
  "preview-branches-new": PreviewBranchesNewFigure,
  "preview-branches-row-menu": PreviewBranchesRowMenuFigure,
  "project-settings-build": ProjectSettingsBuildFigure,
  "project-settings-git": ProjectSettingsGitFigure,
  query: QueryFigure,
  "replay-run": ReplayRunFigure,
  "run-detail": RunDetailFigure,
  "run-error": RunErrorFigure,
  "run-page": RunPageFigure,
  "run-page-metadata": RunPageMetadataFigure,
  "run-page-span": RunPageSpanFigure,
  "run-resource-monitor": RunResourceMonitorFigure,
  "run-resource-monitor-ffmpeg": RunResourceMonitorFfmpegFigure,
  "run-trace": RunTraceFigure,
  "run-trace-instrumented": RunTraceInstrumentedFigure,
  "runs-list": RunsListFigure,
  "runs-list-filter-tags": RunsListFilterTagsFigure,
  "runs-list-row-menu": RunsListRowMenuFigure,
  "runs-list-tags": RunsListTagsFigure,
  schedules: SchedulesFigure,
  "schedules-new": SchedulesNewFigure,
  "tasks-list": TasksListFigure,
  "test-scheduled-task": TestScheduledTaskFigure,
  "test-task": TestTaskFigure,
  usage: UsageFigure,
  webhooks: WebhooksFigure,
  "webhook-endpoint-settings": WebhookEndpointSettingsFigure,
  "webhook-endpoint-test": WebhookEndpointTestFigure,
  "webhook-delivery": WebhookDeliveryFigure,
  regions: RegionsFigure,
  "private-connections": PrivateConnectionsFigure,
  "private-connections-new": PrivateConnectionsNewFigure,
  "prompt-override": PromptOverrideFigure,
};
