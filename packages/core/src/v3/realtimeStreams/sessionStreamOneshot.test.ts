import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../apiClient/index.js";
import { trimSessionStream, writeSessionControlRecord } from "./sessionStreamOneshot.js";

function apiClientStub() {
  const initializeSessionStream = vi.fn(async () => ({ headers: {} }));
  return { client: { initializeSessionStream } as unknown as ApiClient, initializeSessionStream };
}

describe("one-shot session stream writes", () => {
  it("use credentials the caller already holds instead of asking the server again", async () => {
    // Catches: every control record (a turn marker, a boundary) and trim paying a
    // server round trip for credentials the channel's writers already hold.
    const { client, initializeSessionStream } = apiClientStub();
    const held = Promise.reject(new Error("held credentials used"));
    held.catch(() => {});

    await expect(
      writeSessionControlRecord(client, "chat-1", "out", "turn-start", [], undefined, held)
    ).rejects.toThrow("held credentials used");
    await expect(trimSessionStream(client, "chat-1", 3, undefined, held)).rejects.toThrow(
      "held credentials used"
    );
    expect(initializeSessionStream).not.toHaveBeenCalled();
  });

  it("still fetch credentials when the caller holds none", async () => {
    // Catches: the shared-credentials path replacing the fetch for callers that
    // pass nothing.
    const { client, initializeSessionStream } = apiClientStub();

    await expect(
      writeSessionControlRecord(client, "chat-1", "out", "turn-complete")
    ).rejects.toThrow(/S2 credentials/);
    expect(initializeSessionStream).toHaveBeenCalledTimes(1);
  });
});
