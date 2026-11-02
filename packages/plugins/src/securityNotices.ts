import type { PluginDatabaseConfig } from "./databaseConfig.js";

/**
 * exposed: the exposed key is still the environment's current key. grace: it was regenerated but
 * the exposed key keeps working until `apiKeyGraceEndsAt`. revoked: the exposed key no longer works.
 */
export type SecurityNoticeApiKeyStatus = "exposed" | "grace" | "revoked";

/** An affected environment. Its secret API key and every environment variable count as exposed. */
export type SecurityNoticeEnvironment = {
  /** Identifies this affected environment within the notice. */
  id: string;
  environmentId: string;
  environmentSlug: string;
  environmentType: string;
  branchName: string | null;
  exposedAt: Date;
  apiKeyStatus: SecurityNoticeApiKeyStatus;
  apiKeyGraceEndsAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: { id: string; name: string | null; email: string } | null;
};

export type SecurityNotice = {
  id: string;
  title: string;
  summary: string;
  detailsUrl: string | null;
  publishedAt: Date;
  environments: SecurityNoticeEnvironment[];
};

export type SecurityNoticeBanner = {
  noticeId: string;
  title: string;
  /** Affected environments in the project nobody has marked as handled yet. */
  openEnvironmentCount: number;
};

/** Development environments belong to one member, so their notices only reach `userId`'s own. */
export type SecurityNoticeScope = {
  organizationId: string;
  projectId: string;
  userId: string;
};

export type AcknowledgeSecurityNoticeResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * Reads published notices for one project. The host checks the user can access the project before
 * calling; every read and write is also filtered by the organization, the project, and the
 * ownership of development environments.
 */
export interface SecurityNoticesController {
  /** The newest published notice with open environments in the project. Runs on every project page. */
  getBanner(scope: SecurityNoticeScope): Promise<SecurityNoticeBanner | null>;
  listForProject(scope: SecurityNoticeScope): Promise<SecurityNotice[]>;
  acknowledge(
    params: SecurityNoticeScope & { noticeEnvironmentId: string }
  ): Promise<AcknowledgeSecurityNoticeResult>;
}

export type SecurityNoticesPluginConfig = {
  database: PluginDatabaseConfig;
};

export interface SecurityNoticesPlugin {
  create(config: SecurityNoticesPluginConfig): SecurityNoticesController;
}
