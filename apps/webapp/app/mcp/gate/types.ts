import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RbacScopeAction, RbacScopeResourceType } from "@trigger.dev/plugins";
import type { RbacAbility } from "@trigger.dev/rbac";
import type { McpIdentity } from "../types";

export type { McpIdentity } from "../types";

export type McpSubject = {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  environmentType?: RuntimeEnvironmentType;
};

export type McpPreviewRefusal = { refuse: string };

export type McpPrecheckDenial =
  | "forbidden"
  | { action: RbacScopeAction; subject: RbacScopeResourceType; id?: string };

export type McpConfirmSpec<A = unknown> = {
  /**
   * The ability is undefined for `user: true` tools; a check that relies on it must deny then.
   * Return `{ action, subject, id? }` to name the missing permission; `id` narrows the token-scope check only.
   */
  precheck?: (
    args: A,
    ability: RbacAbility | undefined,
    subject: McpSubject | null
  ) => McpPrecheckDenial | void | Promise<McpPrecheckDenial | void>;
  preview: (
    args: A,
    subject: McpSubject | null
  ) => string | McpPreviewRefusal | Promise<string | McpPreviewRefusal>;
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
  confirmation?: { id: string; preview: string };
};
