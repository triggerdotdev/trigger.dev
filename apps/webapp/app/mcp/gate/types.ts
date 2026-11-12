import type { RuntimeEnvironmentType } from "@trigger.dev/database";

export type { McpIdentity } from "../types";

export type McpToolAuth =
  | { action: string; subject: string }
  | { public: true }
  /** No project subject: the handler must filter by `identity.userId` membership itself. */
  | { user: true; action: string; subject: string };

export type McpSubject = {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  environmentType?: RuntimeEnvironmentType;
};
