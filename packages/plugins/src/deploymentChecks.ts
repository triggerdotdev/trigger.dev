import type { PluginDatabaseConfig } from "./databaseConfig.js";
import type { DeploymentAccessBillingStatus } from "./deploymentAccess.js";

/** How one deployment is checked. */
export type DeploymentCheckPlan = "gate" | "shadow" | "skip";

/** The plugin reads its own settings; the host only says which deployment finished. */
export type DeploymentCheckDecisionInput = {
  organizationId: string;
  deploymentId: string;
};

export type DeploymentCheckDecision = {
  plan: DeploymentCheckPlan;
  /** A short, low-cardinality label for logs and metrics. */
  selectedBy: string;
};

/**
 * The image as the host read it from its registry, so the check needs no registry access of its
 * own: the manifest exactly as the registry returned it, and one short-lived download URL per blob
 * it names (the config and every layer). The URLs are credentials: never log them.
 */
export type DeploymentCheckImage = {
  manifest: string;
  mediaType: string;
  /** Blob digest to download URL. */
  blobUrls: Record<string, string>;
};

export type DeploymentCheckInput = {
  organizationId: string;
  projectRef: string;
  deploymentId: string;
  imageDigest: string;
  /** Left out when the host couldn't read the image; the check then has to get it another way. */
  image?: DeploymentCheckImage;
  decision: DeploymentCheckDecision & { plan: Exclude<DeploymentCheckPlan, "skip"> };
};

/**
 * pass, flagged and fail are answers. flagged is a pass that found something worth a look: it never
 * stops a deployment. unavailable means there is no answer.
 */
export type DeploymentCheckOutcome = "pass" | "flagged" | "fail" | "unavailable";

export type DeploymentCheckResult = {
  outcome: DeploymentCheckOutcome;
  /** Opaque. Ties this result to the plugin's own records. */
  id: string;
  /** Only for unavailable: asking again later may get an answer. */
  retryable: boolean;
};

export type DeploymentChecksPluginConfig = {
  database: PluginDatabaseConfig;
  /** The organization's billing status, as the host's billing client reports it. */
  billingStatus(organizationId: string): Promise<DeploymentAccessBillingStatus>;
};

export interface DeploymentChecksController {
  /** Never throws. */
  decide(input: DeploymentCheckDecisionInput): Promise<DeploymentCheckDecision>;
  /** Never throws. */
  check(input: DeploymentCheckInput): Promise<DeploymentCheckResult>;
}

export interface DeploymentChecksPlugin {
  /** Null when the plugin isn't configured. */
  create(config: DeploymentChecksPluginConfig): DeploymentChecksController | null;
}
