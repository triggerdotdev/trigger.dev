import { FEATURE_FLAG } from "../featureFlags";
import type { makeFlag } from "../featureFlags.server";
import { effectiveEventStore } from "./effectiveEventStore";

type ResolveEventStoreOptions = {
  /** Set for child runs, which inherit their parent's store. */
  parentStore?: string;
  /** The organization's flag overrides. */
  featureFlags: Record<string, unknown> | undefined;
  flag: ReturnType<typeof makeFlag>;
  defaultStore: "postgres" | "clickhouse" | "clickhouse_v2";
  v1RerouteEnabled: boolean;
  /** Called when a flag override (not the env default) still selects the retired v1 store. */
  onLegacyFlagStore?: () => void;
};

/** The effective event store for a new run, or for an org's configured store when there's no parent. */
export async function resolveEventStore({
  parentStore,
  featureFlags,
  flag,
  defaultStore,
  v1RerouteEnabled,
  onLegacyFlagStore,
}: ResolveEventStoreOptions): Promise<string> {
  const store =
    parentStore ??
    (await flag({
      key: FEATURE_FLAG.taskEventRepository,
      defaultValue: defaultStore,
      overrides: featureFlags,
    }));

  if (!parentStore && store === "clickhouse" && defaultStore !== "clickhouse") {
    onLegacyFlagStore?.();
  }

  return effectiveEventStore(store, v1RerouteEnabled);
}
