import { createServer } from "node:http";
import { once } from "node:events";
import { apiClientManager } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it } from "vitest";
import { sessions } from "./sessions.js";
import { streams } from "./streams.js";

describe("stream wait registration", () => {
  // Catches: scoped waits calling the separate waitpoint-read route, or dropping old-server support.
  it.each([true, false])("handles creation with isBlocked=%s", async (isBlocked) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      response.setHeader("Content-Type", "application/json");
      if (path.endsWith("/input-streams/wait") || path.endsWith("/session-streams/wait")) {
        response.end(
          JSON.stringify({
            waitpointId: "waitpoint_test",
            isCached: false,
            ...(isBlocked ? { isBlocked: true } : {}),
          })
        );
      } else if (!isBlocked && path.endsWith("/waitpoints/tokens/waitpoint_test/wait")) {
        response.end(JSON.stringify({ success: true }));
      } else {
        response.writeHead(403).end(JSON.stringify({ error: "Missing waitpoint access" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");

    try {
      await apiClientManager.runWithConfig(
        { baseURL: `http://127.0.0.1:${address.port}`, accessToken: "test-credential" },
        () =>
          runInMockTaskContext(async () => {
            expect(await streams.input({ id: "approval" }).wait()).toMatchObject({ ok: true });
            expect(await sessions.open("session_test").in.awaitWake()).toMatchObject({ ok: true });
          })
      );
      expect(requests.filter((path) => path.includes("/waitpoints/tokens/"))).toHaveLength(
        isBlocked ? 0 : 2
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
