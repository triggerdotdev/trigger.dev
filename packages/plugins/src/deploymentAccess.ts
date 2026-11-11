import type { PluginDatabaseConfig } from "./databaseConfig.js";

/**
 * Where the host asks.
 *
 * - preflight: could this organization deploy at all (a deploy button, onboarding, attaching to a
 *   deployment that already exists). Nothing is recorded.
 * - initialize: a deployment is about to be created.
 * - register_worker: a finished build is registering its tasks.
 */
export type DeploymentAccessStage = "preflight" | "initialize" | "register_worker";

export type DeploymentAccessCheck = {
  stage: DeploymentAccessStage;
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  deploymentId?: string;
  /** The deployment's content hash, as the client sent it. */
  contentHash?: string;
  hasGitMetadata?: boolean;
  /** Tasks the build registers. Set at register_worker. */
  taskCount?: number;
  triggeredVia?: string;
  cliVersion?: string;
};

export type DeploymentAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      /**
       * denied: refuse the request now. limited: a temporary limit; the host applies it only once
       * the request would create something, so an idempotent retry still succeeds.
       */
      kind: "denied" | "limited";
      /** Shown to the user. Absent: the host's generic message. */
      message?: string;
    };

/** Whether the organization may start a new connection to each integration. */
export type DeploymentIntegrationAccess = { github: boolean; vercel: boolean };

/** The organization's billing status, as the host's billing client reports it. */
export type DeploymentAccessBillingStatus = "paying" | "non_paying" | "unknown" | "not_configured";

export type SlidingWindowHitResult =
  | { status: "counted"; count: number; limited: boolean }
  | { status: "unavailable" };

export type DeploymentAccessPluginConfig = {
  database: PluginDatabaseConfig;
  billingStatus(organizationId: string): Promise<DeploymentAccessBillingStatus>;
  /**
   * Counts one hit for `key` in a sliding window. Counting stops at `limit`, so a hit past it
   * reports `limited` without extending the window. Never throws: a store that doesn't answer
   * reports `unavailable`.
   */
  slidingWindowHit(params: {
    key: string;
    limit: number;
    window: "1h" | "1d";
  }): Promise<SlidingWindowHitResult>;
};

export interface DeploymentAccessController {
  checkDeploy(check: DeploymentAccessCheck): Promise<DeploymentAccessDecision>;
  integrationAccess(organizationId: string): Promise<DeploymentIntegrationAccess>;
  /**
   * Whether the organization has an override that hasn't expired, whatever it sets. Optional: a
   * plugin without it reports none.
   */
  hasActiveOverride?(organizationId: string): Promise<boolean>;
}

export interface DeploymentAccessPlugin {
  create(config: DeploymentAccessPluginConfig): DeploymentAccessController;
}
