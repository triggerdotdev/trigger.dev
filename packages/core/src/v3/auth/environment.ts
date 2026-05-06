// Slim shape of an authenticated runtime environment, structural and
// independent of @trigger.dev/database. Carried across the auth boundary
// (RBAC plugin contract → host webapp) so plugins can return all the
// fields handlers consume without a follow-up DB lookup.
//
// This is hand-rolled rather than derived from `Prisma.RuntimeEnvironmentGetPayload`
// because the contract package (@trigger.dev/plugins) is published while
// @trigger.dev/database is private — and because callers of this type
// genuinely use only a fraction of the columns Prisma would expose.
//
// If a downstream consumer needs a field that's not here:
//   - Used in the auth-cross-cutting hot path → add it
//   - Used in a service that already loads the env → fetch it there instead
//
// `concurrencyLimitBurstFactor` is a `Decimal(4,2)` in Postgres — values
// are O(2.00) in practice; coerced to `number` here (lossless at this
// scale, avoids dragging in Prisma's Decimal class via type imports).

// String-literal unions mirror the corresponding Prisma enums. Defining
// them here keeps the contract structural (no @trigger.dev/database
// import) while giving downstream consumers the same exact union they
// expect when this value is passed to a Prisma column.
export type RuntimeEnvironmentType =
  | "PRODUCTION"
  | "STAGING"
  | "DEVELOPMENT"
  | "PREVIEW";

export type RunEngineVersion = "V1" | "V2";

// Prisma's Decimal class. Accept it structurally so consumers (mostly
// the webapp's `runtimeEnvironment.server.ts` model functions) can pass
// raw Prisma rows without coercion. Plugins that don't have a Decimal
// type at hand (cloud's Drizzle plugin) return plain `number`.
type DecimalLike = { toNumber(): number };

export type AuthenticatedEnvironment = {
  id: string;
  slug: string;
  type: RuntimeEnvironmentType;
  apiKey: string;
  organizationId: string;
  projectId: string;
  orgMemberId: string | null;
  parentEnvironmentId: string | null;
  branchName: string | null;
  archivedAt: Date | null;
  paused: boolean;
  shortcode: string;
  maximumConcurrencyLimit: number;
  concurrencyLimitBurstFactor: number | DecimalLike;
  // Prisma JSON column. Specific flags read it with their own narrower
  // types. Pass-through for legacy override paths in marqs / sharedQueue.
  builtInEnvironmentVariableOverrides: unknown;
  // Bookkeeping timestamps. Prisma rows always have them; non-Prisma
  // plugins can fill in with `new Date()` or whatever's appropriate.
  createdAt: Date;
  updatedAt: Date;

  project: {
    id: string;
    slug: string;
    name: string;
    externalRef: string;
    engine: RunEngineVersion;
    deletedAt: Date | null;
    defaultWorkerGroupId: string | null;
    // Same id as env.organizationId — present on Prisma's Project row
    // and read by deployment services that operate on the project alone.
    organizationId: string;
    // Build-server bookkeeping. Read by remote-image-builder when
    // creating Depot builds.
    builderProjectId: string | null;
  };

  organization: {
    id: string;
    slug: string;
    title: string;
    streamBasinName: string | null;
    maximumConcurrencyLimit: number | null;
    runsEnabled: boolean;
    maximumDevQueueSize: number | null;
    maximumDeployedQueueSize: number | null;
    // Per-org feature flags + rate-limit config. Loosely typed (Prisma
    // JSON) — handlers that care about specific keys read with their
    // own narrower types.
    featureFlags: unknown;
    apiRateLimiterConfig: unknown;
    batchRateLimitConfig: unknown;
    batchQueueConcurrencyConfig: unknown;
  };

  // `user` is optional because most call sites only fetch `userId`.
  // Code paths that need user details (display name etc.) include it
  // explicitly in their Prisma query. The whole field is optional too
  // so admin construction sites that build env literals without it
  // satisfy the type.
  orgMember?: {
    userId: string;
    user?: { id: string; displayName: string | null; name: string | null };
  } | null;

  // Optional + nullable: optional so admin routes that don't explicitly
  // include parentEnvironment satisfy the type; nullable so Prisma rows
  // with a null left-join result satisfy too.
  parentEnvironment?: { id: string; apiKey: string } | null;
};
