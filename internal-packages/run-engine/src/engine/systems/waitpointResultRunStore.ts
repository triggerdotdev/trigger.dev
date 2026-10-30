import {
  CompletedWaitpointHydratingRunStore,
  type ReadClient,
  type RunStore,
} from "@internal/run-store";
import type { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import {
  resolveCompletedWaitpointRecords,
  UnresolvableCompletedWaitpointRecordsError,
} from "./completedWaitpointRecordAdapter.js";
import { createCompletedWaitpointResolver } from "./completedWaitpointResolver.js";

/** Independent of TRES enrollment: an older parent can reuse a newer shared RUN child. */
export function createWaitpointResultRunStore(
  delegate: RunStore,
  options: {
    store: Pick<WaitpointStoreCoordinator, "readCompletedRecords">;
    primaryReadClient?: ReadClient;
    isEnabled: (organizationId: string) => boolean | Promise<boolean>;
  }
): RunStore {
  if (delegate instanceof CompletedWaitpointHydratingRunStore) return delegate;
  const expand = createCompletedWaitpointResolver(delegate, options.primaryReadClient, true);
  return new CompletedWaitpointHydratingRunStore(delegate, {
    primaryReadClient: options.primaryReadClient,
    isEnabled: options.isEnabled,
    resolve: async (ids, context) => {
      const records = await resolveCompletedWaitpointRecords({
        requestedIds: ids,
        legacyReader: async () => [],
        storeReader: async (requested) => {
          const entries = await options.store.readCompletedRecords(requested, context.runId);
          for (const [id, entry] of entries) {
            if (entry.record.environmentId !== context.environmentId) {
              throw new UnresolvableCompletedWaitpointRecordsError(
                `Waitpoint ${id} belongs to another environment`,
                id
              );
            }
          }
          return entries;
        },
      });
      return expand({
        runId: context.runId,
        order: [],
        records,
        pointer: { cycleSeq: 0, count: records.length },
      });
    },
  });
}
