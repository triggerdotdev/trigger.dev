import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  REALTIME_STREAMS_DEFAULT_VERSION: "v1" as "v1" | "v2",
  REALTIME_STREAMS_S2_BASIN: undefined as string | undefined,
  REALTIME_STREAMS_S2_ACCESS_TOKEN: undefined as string | undefined,
  REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS: "false",
}));

vi.mock("~/env.server", () => ({ env: envMock }));

import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";

function configureS2() {
  envMock.REALTIME_STREAMS_S2_BASIN = "a-basin";
  envMock.REALTIME_STREAMS_S2_ACCESS_TOKEN = "a-token";
}

beforeEach(() => {
  envMock.REALTIME_STREAMS_DEFAULT_VERSION = "v1";
  envMock.REALTIME_STREAMS_S2_BASIN = undefined;
  envMock.REALTIME_STREAMS_S2_ACCESS_TOKEN = undefined;
  envMock.REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS = "false";
});

describe("determineRealtimeStreamsVersion", () => {
  it("honours an explicit v2 when S2 is configured", () => {
    configureS2();
    expect(determineRealtimeStreamsVersion("v2")).toBe("v2");
  });

  it("accepts a skip-tokens deployment as configured", () => {
    envMock.REALTIME_STREAMS_S2_BASIN = "a-basin";
    envMock.REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS = "true";
    expect(determineRealtimeStreamsVersion("v2")).toBe("v2");
  });

  it("degrades an explicit v2 to v1 when S2 is not configured", () => {
    expect(determineRealtimeStreamsVersion("v2")).toBe("v1");
  });

  it("falls back to the default version when the caller expresses no preference", () => {
    configureS2();
    envMock.REALTIME_STREAMS_DEFAULT_VERSION = "v2";
    expect(determineRealtimeStreamsVersion()).toBe("v2");
  });

  it("degrades a v2 default to v1 when S2 is not configured", () => {
    envMock.REALTIME_STREAMS_DEFAULT_VERSION = "v2";
    expect(determineRealtimeStreamsVersion()).toBe("v1");
  });

  it("requires a basin, not just a token", () => {
    envMock.REALTIME_STREAMS_S2_ACCESS_TOKEN = "a-token";
    envMock.REALTIME_STREAMS_DEFAULT_VERSION = "v2";
    expect(determineRealtimeStreamsVersion()).toBe("v1");
    expect(determineRealtimeStreamsVersion("v2")).toBe("v1");
  });

  it("keeps an explicit v1 on v1 even where S2 is available", () => {
    configureS2();
    envMock.REALTIME_STREAMS_DEFAULT_VERSION = "v2";
    expect(determineRealtimeStreamsVersion("v1")).toBe("v1");
  });

  it("treats an unrecognised version as v1", () => {
    configureS2();
    expect(determineRealtimeStreamsVersion("v3")).toBe("v1");
  });
});
