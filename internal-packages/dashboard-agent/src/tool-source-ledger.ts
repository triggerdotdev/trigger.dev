import type { ToolSet } from "ai";
import { apiGet } from "./tool-api-client";
import type { RepoSnapshot } from "./repo-tools";

/**
 * Which files a turn read and at which commit. The ledger is the only proof a source
 * citation can canonicalize against: a snapshot sha is not proof of reading.
 */

/** The part of the ledger evidence canonicalisation reads. */
export type SourceReadLookup = {
  wasReadThisTurn(path: string, sha: string): boolean;
  /** The commit a read was served from: the run-pinned snapshot, else the default. */
  shaForReadPath(path: string): string | undefined;
  /** True if the deployment pinned to `sha` was built from an uncommitted-changes tree. */
  dirtyForSha(sha: string): boolean;
};

export type SourceReadLedger = SourceReadLookup & {
  resolveRunSnapshot(runId: string): Promise<RepoSnapshot | null>;
  /** Records a successful read against its commit, keeping repo-tools unaware of it. */
  withReadTracking(repoTools: ToolSet): ToolSet;
};

export type SourceLedgerContext = {
  origin: string;
  hasAuth: boolean;
  userActorToken?: string;
  projectRef?: string;
  environmentName?: string;
  environmentBranch?: string;
  repoSnapshot?: RepoSnapshot;
};

export function createSourceReadLedger(ctx: SourceLedgerContext): SourceReadLedger {
  const { origin, hasAuth, userActorToken, projectRef, environmentName, environmentBranch } = ctx;

  // Null means the file tools fall back to the default tracked-branch snapshot.
  const fetchRunSnapshot = async (runId: string): Promise<RepoSnapshot | null> => {
    if (!hasAuth || !projectRef || !environmentName) return null;
    const result = await apiGet(
      origin,
      `/api/v1/projects/${projectRef}/${environmentName}/repo/snapshot?runId=${encodeURIComponent(runId)}`,
      userActorToken!,
      environmentBranch
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
      dirty: d.dirty,
    };
  };

  // Memoized per turn so the file tools and the read tracker below agree on the commit.
  const runSnapshots = new Map<string, Promise<RepoSnapshot | null>>();
  const resolveRunSnapshot = (runId: string): Promise<RepoSnapshot | null> => {
    let pending = runSnapshots.get(runId);
    if (!pending) {
      pending = fetchRunSnapshot(runId);
      runSnapshots.set(runId, pending);
    }
    return pending;
  };

  // Which files this turn read, and at which commit. A source citation canonicalizes
  // only against a read recorded here.
  const filesReadBySha = new Map<string, Set<string>>();
  // A commit's dirty stamp, keyed by sha — code-provided, never re-derived from the prompt.
  const dirtyBySha = new Map<string, boolean>();
  if (ctx.repoSnapshot?.dirty) dirtyBySha.set(ctx.repoSnapshot.sha, true);

  function recordFileRead(path: string, sha: string, dirty: boolean) {
    const key = path.replace(/^\/+/, "");
    const shas = filesReadBySha.get(key) ?? new Set<string>();
    shas.add(sha);
    filesReadBySha.set(key, shas);
    // Sticky true: two snapshots can share a sha (a dirty run-pinned deploy off the
    // same commit as the clean tracked branch) — a later clean read must never erase
    // the caveat a dirty read already earned.
    dirtyBySha.set(sha, dirty || (dirtyBySha.get(sha) ?? false));
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

  function dirtyForSha(sha: string): boolean {
    return dirtyBySha.get(sha) ?? false;
  }

  function withReadTracking(repoTools: ToolSet): ToolSet {
    const readFile = repoTools.read_file;
    if (!readFile?.execute) return repoTools;
    const execute = readFile.execute.bind(readFile);
    return {
      ...repoTools,
      read_file: {
        ...readFile,
        execute: async (input: any, options: any) => {
          const result = await execute(input, options);
          const path = (result as { path?: string } | undefined)?.path;
          if (path && !(result as { error?: unknown }).error) {
            const snap = input?.runId ? await resolveRunSnapshot(input.runId) : ctx.repoSnapshot;
            if (snap?.sha) recordFileRead(path, snap.sha, snap.dirty ?? false);
          }
          return result;
        },
      } as (typeof repoTools)[string],
    };
  }

  return {
    resolveRunSnapshot,
    wasReadThisTurn,
    shaForReadPath,
    dirtyForSha,
    withReadTracking,
  };
}
