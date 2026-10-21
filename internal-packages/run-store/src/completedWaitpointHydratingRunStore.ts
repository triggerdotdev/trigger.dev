import type { Prisma } from "@trigger.dev/database";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import type {
  LatestExecutionSnapshotRead,
  ReadClient,
  RunStore,
  SnapshotReadWaitpoint,
} from "./types.js";
import { snapshotRouteFromSnapshot, type SnapshotReadContext } from "./snapshotResidency.js";

export type WaitpointResultReadContext = {
  runId: string;
  organizationId: string;
  environmentId: string;
};

/** Completes Postgres snapshot joins without changing either record's authoritative store. */
export class CompletedWaitpointHydratingRunStore extends DelegatingRunStore {
  constructor(
    delegate: RunStore,
    private readonly options: {
      /** Writer signal for routed delegates, which resolve their own primary by run id. */
      primaryReadClient?: ReadClient;
      isEnabled: (organizationId: string) => boolean | Promise<boolean>;
      resolve: (
        ids: string[],
        context: WaitpointResultReadContext
      ) => Promise<SnapshotReadWaitpoint[]>;
    }
  ) {
    super(delegate);
  }

  async #hydrate(snapshot: LatestExecutionSnapshotRead): Promise<void> {
    // Disabled reads skip residency parsing as well as all hydration queries and processing.
    if (!(await this.options.isEnabled(snapshot.organizationId))) return;
    const route = snapshotRouteFromSnapshot(snapshot);
    // MemoryDB-primary reads already resolve their complete authoritative cycle.
    if (route.residency === "redis-primary") return;
    const present = new Set(snapshot.completedWaitpoints.map((w) => w.id));
    const ids = await this.delegate.findSnapshotCompletedWaitpointIds(
      snapshot.id,
      // A mirrored read may have repaired the row from primary after a replica miss.
      // Discover links on the owning primary too, so an older reader cannot erase its results.
      this.options.primaryReadClient ?? this.delegate.primaryReadClient,
      snapshot.runId,
      route
    );
    const missing = [...new Set(ids)].filter(
      (id) => !present.has(id) && parseWaitpointId(id).format !== "legacy"
    );
    if (missing.length === 0) return;
    const recovered = await this.options.resolve(missing, {
      runId: snapshot.runId,
      organizationId: snapshot.organizationId,
      environmentId: snapshot.environmentId,
    });
    const byId = new Map(recovered.map((w) => [w.id, w]));
    if (byId.size !== missing.length || missing.some((id) => !byId.has(id))) {
      throw new Error(`Incomplete shared waitpoint results for snapshot ${snapshot.id}`);
    }
    snapshot.completedWaitpoints = [
      ...snapshot.completedWaitpoints,
      ...missing.map((id) => byId.get(id)!),
    ];
  }

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    environmentId?: string,
    organizationId?: SnapshotReadContext
  ): Promise<LatestExecutionSnapshotRead | null> {
    const snapshot = await this.delegate.findLatestExecutionSnapshot(
      runId,
      client,
      environmentId,
      organizationId
    );
    if (snapshot) await this.#hydrate(snapshot);
    return snapshot;
  }

  override async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient,
    organizationId?: SnapshotReadContext
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const snapshot = await this.delegate.findExecutionSnapshot(args, client, organizationId);
    // Full include preserves the snapshot's own tenant context; scalar/select queries pass through.
    if (snapshot && args.include?.completedWaitpoints === true && !args.select) {
      await this.#hydrate(snapshot as unknown as LatestExecutionSnapshotRead);
    }
    return snapshot;
  }
}
