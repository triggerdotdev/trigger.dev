/** What happened. Field names follow the OCSF API Activity class where one exists. */
export type AdminAuditActivity =
  | "api_call"
  | "dashboard_action"
  | "pat_created"
  /** An admin started impersonating a user, from any entry point (some start on a GET). */
  | "impersonation_started";

export type AdminAuditActorKind =
  | "user_pat"
  | "user_session"
  | "billing_service"
  | "unauthenticated";

/** Who made the request. `tokenId` is the PAT row id, never the token value. */
export type AdminAuditActor = {
  kind: AdminAuditActorKind;
  userId?: string;
  email?: string;
  isAdmin?: boolean;
  tokenId?: string;
  /** Set when a session user was impersonating another user during the request. */
  impersonatedUserId?: string;
};

export type AdminAuditSourceEndpoint = {
  ip: string | null;
  userAgent: string | null;
};

export type AdminAuditHttp = {
  method: string;
  /** Path without the query string. */
  path: string;
  status: number;
  durationMs: number;
};

export type AdminAuditPat = {
  tokenId: string;
  name: string;
};

export type AdminAuditEvent = {
  /** Unique per event; alerts quote it so the archived copy can be found. */
  id: string;
  time: Date;
  activity: AdminAuditActivity;
  actor: AdminAuditActor;
  srcEndpoint: AdminAuditSourceEndpoint;
  http: AdminAuditHttp | null;
  requestId: string | null;
  /** Top-level request body keys with short scalar values; secret-looking keys are redacted. */
  bodySummary: Record<string, unknown> | null;
  pat: AdminAuditPat | null;
};

export type AdminAuditIpLocation = {
  country: string | null;
  countryCode: string | null;
  asn: number | null;
  asName: string | null;
};

export interface AdminAuditController {
  /** Never throws and never blocks the request; delivery happens in the background. */
  record(event: AdminAuditEvent): void;
  /** Resolves when every recorded event has been processed. For tests and shutdown. */
  flush(): Promise<void>;
}

export type AdminAuditPluginConfig = {
  /** Approximate location of an IP, or undefined when unknown. Must not throw. */
  lookupIpLocation: (ip: string) => Promise<AdminAuditIpLocation | undefined>;
  /** The deployment's public origin, shown in alerts so test and prod can be told apart. */
  appOrigin: string;
};

export interface AdminAuditPlugin {
  create(config: AdminAuditPluginConfig): AdminAuditController;
}
