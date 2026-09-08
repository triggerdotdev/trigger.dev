import { apiGet, type EnvTarget } from "./tool-api-client";
import type { RepoSnapshot } from "./repo-tools";

// Which files a turn read and at which commit — the only proof a source citation can
// canonicalize against; a snapshot sha is not proof of reading.

/** The environment an object was actually read from. `environmentName` is for user-facing
 * messages only — a URI keys on `environmentId` alone. */
export type ReadScope = { projectRef: string; environmentId: string; environmentName?: string };

/** Identities that aren't globally unique, so scope has to key off kind + id. */
export type ScopedReadKind = "error" | "queue" | "deployment" | "report";

/** The part of the ledger evidence canonicalisation reads. */
export type SourceReadLookup = {
  wasReadThisTurn(path: string, sha: string): boolean;
  /** The commit a read was served from: the run-pinned snapshot, else the default. */
  shaForReadPath(path: string): string | undefined;
  /** Every scope a (path, sha) read was served from this turn — a source tool can target a sibling project/environment. */
  scopesForSourceRead(path: string, sha: string): ReadScope[];
  /** The scope a run was read from, if other than the conversation's own; friendly ids need no compound key. */
  scopeForRun(runId: string): ReadScope | undefined;
  /** Every scope an error/queue/deployment identity was read from this turn — names aren't globally unique. */
  scopesForScopedRead(kind: ScopedReadKind, id: string): ReadScope[];
};

export type SourceReadLedger = SourceReadLookup & {
  resolveRunSnapshot(runId: string, target: EnvTarget): Promise<RepoSnapshot | null>;
  /** Records a read the source tools report, at the commit and target they resolved. */
  recordRepoRead(read: {
    path: string;
    sha: string;
    target?: EnvTarget;
    /** Stated by the reader, never inferred here: an unstated target fails closed. */
    targeted: boolean;
  }): Promise<void>;
  /** Records which scope a run's data (and its spans) was read from. */
  recordTraceSpans(runId: string, scope: ReadScope): void;
  /** Records a scope an error/queue/deployment identity was read from, deduped by environment. */
  recordScopedRead(kind: ScopedReadKind, id: string, scope: ReadScope): void;
  /** Records a scope a (path, sha) read was served from, deduped by environment. */
  recordSourceRead(path: string, sha: string, scope: ReadScope): void;
};

export type SourceLedgerContext = {
  origin: string;
  hasAuth: boolean;
  userActorToken?: string;
  projectRef?: string;
  environmentName?: string;
  environmentBranch?: string;
  repoSnapshot?: RepoSnapshot;
  /** Resolves a target to the RuntimeEnvironment id it read from, to scope a source read
   * the same way the API tools scope theirs. */
  environmentIdFor?: (target: EnvTarget) => Promise<string | undefined>;
};

export function createSourceReadLedger(ctx: SourceLedgerContext): SourceReadLedger {
  const { origin, hasAuth, userActorToken } = ctx;

  // Null means the file tools fall back to the default tracked-branch snapshot.
  const fetchRunSnapshot = async (
    runId: string,
    target: EnvTarget
  ): Promise<RepoSnapshot | null> => {
    if (!hasAuth) return null;
    const result = await apiGet(
      origin,
      `/api/v1/projects/${encodeURIComponent(target.projectRef)}/${encodeURIComponent(target.environmentName)}/repo/snapshot?runId=${encodeURIComponent(runId)}`,
      userActorToken!,
      target.branch
    );
    if (!result.ok) return null;
    const d = result.data as Partial<RepoSnapshot> | undefined;
    if (!d?.tarballUrl || !d.owner || !d.repo || !d.sha) return null;
    return {
      tarballUrl: d.tarballUrl,
      owner: d.owner,
      repo: d.repo,
      sha: d.sha,
      defaultBranch: d.defaultBranch,
    };
  };

  // Memoized per turn so the file tools and the read tracker below agree on the commit.
  const runSnapshots = new Map<string, Promise<RepoSnapshot | null>>();
  const resolveRunSnapshot = (runId: string, target: EnvTarget): Promise<RepoSnapshot | null> => {
    const key = `${target.projectRef}/${target.environmentName}/${target.branch ?? ""}/${runId}`;
    let pending = runSnapshots.get(key);
    if (!pending) {
      pending = fetchRunSnapshot(runId, target);
      runSnapshots.set(key, pending);
    }
    return pending;
  };

  // A source citation canonicalizes only against a read recorded here.
  const filesReadBySha = new Map<string, Set<string>>();

  function recordFileRead(path: string, sha: string) {
    const key = path.replace(/^\/+/, "");
    const shas = filesReadBySha.get(key) ?? new Set<string>();
    shas.add(sha);
    filesReadBySha.set(key, shas);
  }

  function wasReadThisTurn(path: string, sha: string): boolean {
    return filesReadBySha.get(path.replace(/^\/+/, ""))?.has(sha) ?? false;
  }

  function shaForReadPath(path: string): string | undefined {
    const shas = filesReadBySha.get(path.replace(/^\/+/, ""));
    if (!shas || shas.size === 0) return undefined;
    // A path read at two commits resolves to the default snapshot's.
    const preferred = ctx.repoSnapshot?.sha;
    if (preferred && shas.has(preferred)) return preferred;
    return [...shas][shas.size - 1];
  }

  // So a citation canonicalizes against the scope actually read from, not the conversation's.
  const runScopes = new Map<string, ReadScope>();
  const scopedReads = new Map<string, ReadScope[]>();
  const sourceScopes = new Map<string, ReadScope[]>();

  function recordTraceSpans(runId: string, scope: ReadScope) {
    runScopes.set(runId, scope);
  }

  function recordScopedRead(kind: ScopedReadKind, id: string, scope: ReadScope) {
    const key = `${kind}:${id}`;
    const scopes = scopedReads.get(key) ?? [];
    if (!scopes.some((s) => s.environmentId === scope.environmentId)) {
      scopes.push(scope);
    }
    scopedReads.set(key, scopes);
  }

  function scopeForRun(runId: string): ReadScope | undefined {
    return runScopes.get(runId);
  }

  function scopesForScopedRead(kind: ScopedReadKind, id: string): ReadScope[] {
    return scopedReads.get(`${kind}:${id}`) ?? [];
  }

  function recordSourceRead(path: string, sha: string, scope: ReadScope) {
    const key = `${path}:${sha}`;
    const scopes = sourceScopes.get(key) ?? [];
    if (!scopes.some((s) => s.environmentId === scope.environmentId)) {
      scopes.push(scope);
    }
    sourceScopes.set(key, scopes);
  }

  function scopesForSourceRead(path: string, sha: string): ReadScope[] {
    return sourceScopes.get(`${path}:${sha}`) ?? [];
  }

  async function recordRepoRead(read: {
    path: string;
    sha: string;
    target?: EnvTarget;
    targeted: boolean;
  }) {
    const path = read.path.replace(/^\/+/, "");
    const environmentId = read.target ? await ctx.environmentIdFor?.(read.target) : undefined;
    // Citable only with a resolved scope, or it would canonicalize to the wrong environment.
    if (read.targeted && !environmentId) return;
    recordFileRead(path, read.sha);
    if (!read.target || !environmentId) return;
    recordSourceRead(path, read.sha, {
      projectRef: read.target.projectRef,
      environmentId,
      environmentName: read.target.environmentName,
    });
  }

  return {
    resolveRunSnapshot,
    wasReadThisTurn,
    shaForReadPath,
    recordRepoRead,
    recordTraceSpans,
    recordScopedRead,
    recordSourceRead,
    scopeForRun,
    scopesForScopedRead,
    scopesForSourceRead,
  };
}
