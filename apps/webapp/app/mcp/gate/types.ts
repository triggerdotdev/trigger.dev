import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RbacAbility } from "@trigger.dev/rbac";
import type { McpIdentity } from "../types";

export type { McpIdentity } from "../types";

export type McpSubject = {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  environmentType?: RuntimeEnvironmentType;
};

export type McpConfirmSpec<A = unknown> = {
  preview: (args: A, subject: McpSubject | null) => string;
};

export type McpToolAuth =
  | { public: true }
  /** No project subject: the handler must filter by `identity.userId` membership itself. */
  | { user: true; action: string; subject: string; confirm?: boolean | McpConfirmSpec }
  | {
      action: string;
      subject: string;
      confirm?: boolean | McpConfirmSpec;
      resourceId?: (args: any) => string | undefined;
      resolveSubject?: (args: unknown, identity: McpIdentity) => Promise<McpSubject | null>;
    };

export type McpRequestExtra = {
  signal: AbortSignal;
  requestId: string | number;
  era?: "legacy" | "modern";
};

export type McpToolContext = {
  identity: McpIdentity;
  subject: McpSubject | null;
  request: Request;
  /** Set for project-scoped tools only. */
  ability?: RbacAbility;
  signal: AbortSignal;
  requestId: string | number;
  confirmation?: { id: string };
};
