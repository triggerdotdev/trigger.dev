import { describe, expect, it } from "vitest";
import type { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";
import { ClickhouseFactory, getQueueMetricsClickhouseClient } from "./clickhouseFactory.server";

const ORG_WITH_OVERRIDE = "org_with_dedicated_ch";
const DEDICATED_CH_URL = "http://dedicated-ch.example:8123";

function registryWithOverride(overrides: Record<string, string>): OrganizationDataStoresRegistry {
  return {
    isLoaded: true,
    isReady: Promise.resolve(),
    get(organizationId: string, kind: string) {
      const url = overrides[organizationId];
      if (kind === "CLICKHOUSE" && url) {
        return { kind: "CLICKHOUSE", url };
      }
      return null;
    },
  } as unknown as OrganizationDataStoresRegistry;
}

describe("ClickhouseFactory queue-metrics routing", () => {
  it("reads queue metrics from the shared warehouse even when the org has a dedicated CH override", () => {
    const factory = new ClickhouseFactory(
      registryWithOverride({ [ORG_WITH_OVERRIDE]: DEDICATED_CH_URL })
    );

    const client = factory.getClickhouseForOrganizationSync(ORG_WITH_OVERRIDE, "queueMetrics");

    expect(client).toBe(getQueueMetricsClickhouseClient());
  });

  it("routes queue metrics to the shared client identically with or without an org override", () => {
    const withOverride = new ClickhouseFactory(
      registryWithOverride({ [ORG_WITH_OVERRIDE]: DEDICATED_CH_URL })
    );
    const withoutOverride = new ClickhouseFactory(registryWithOverride({}));

    const overrideClient = withOverride.getClickhouseForOrganizationSync(
      ORG_WITH_OVERRIDE,
      "queueMetrics"
    );
    const defaultClient = withoutOverride.getClickhouseForOrganizationSync(
      ORG_WITH_OVERRIDE,
      "queueMetrics"
    );

    expect(overrideClient).toBe(defaultClient);
    expect(overrideClient).toBe(getQueueMetricsClickhouseClient());
  });

  it("still honors the per-org override for non-shared client types (events)", () => {
    const withOverride = new ClickhouseFactory(
      registryWithOverride({ [ORG_WITH_OVERRIDE]: DEDICATED_CH_URL })
    );
    const withoutOverride = new ClickhouseFactory(registryWithOverride({}));

    const overrideEvents = withOverride.getClickhouseForOrganizationSync(
      ORG_WITH_OVERRIDE,
      "events"
    );
    const defaultEvents = withoutOverride.getClickhouseForOrganizationSync(
      ORG_WITH_OVERRIDE,
      "events"
    );

    expect(overrideEvents).not.toBe(defaultEvents);
  });
});
