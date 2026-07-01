// The marker always lives on the OLD (legacy/control-plane) run-ops DB; single-container
// `containerTest` is faithful coverage. Cross-version (old marker on the legacy DB /
// new write on the dedicated run-ops DB) interplay is exercised end-to-end by the
// live-migration test on `heteroPostgresTest`.
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  ensureRedirectMarkerTable,
  writeRedirectMarker,
  readRedirectMarker,
  isFenced,
} from "./redirectMarker.js";

vi.setConfig({ testTimeout: 60_000 });

describe("redirectMarker", () => {
  containerTest("writes and reads back a marker (round-trip)", async ({ prisma }) => {
    await ensureRedirectMarkerTable(prisma);

    const runId = "run_abc123";
    await writeRedirectMarker(prisma, { runId, reason: "live-migration" });

    const marker = await readRedirectMarker(prisma, runId);
    expect(marker).not.toBeNull();
    expect(marker?.runId).toBe(runId);
    expect(marker?.targetDb).toBe("NEW");
    expect(marker?.reason).toBe("live-migration");
    expect(marker?.markedAt).toBeInstanceOf(Date);

    expect(await readRedirectMarker(prisma, "run_does_not_exist")).toBeNull();
  });

  containerTest("isFenced flips false→true at the marker boundary", async ({ prisma }) => {
    await ensureRedirectMarkerTable(prisma);
    const runId = "run_fence_boundary";

    // Before any NEW-side write the migration writes the marker; old side is not yet fenced.
    expect(await isFenced(prisma, runId)).toBe(false);

    // Marker written in OLD before first NEW write -> old side now fences off.
    await writeRedirectMarker(prisma, { runId, reason: "live-migration" });
    expect(await isFenced(prisma, runId)).toBe(true);
  });

  containerTest(
    "writeRedirectMarker is idempotent and preserves the first markedAt",
    async ({ prisma }) => {
      await ensureRedirectMarkerTable(prisma);
      const runId = "run_idempotent";

      await writeRedirectMarker(prisma, { runId, reason: "first" });
      const first = await readRedirectMarker(prisma, runId);

      // Simulate a retried migration writing the marker again.
      await new Promise((r) => setTimeout(r, 10));
      await writeRedirectMarker(prisma, { runId, reason: "second" });
      const second = await readRedirectMarker(prisma, runId);

      expect(second?.markedAt.getTime()).toBe(first?.markedAt.getTime()); // unchanged
      expect(second?.reason).toBe("first"); // ON CONFLICT DO NOTHING -> original wins
    }
  );

  containerTest(
    "concurrent old-side advance is fenced once the marker exists",
    async ({ prisma }) => {
      await ensureRedirectMarkerTable(prisma);
      const runId = "run_concurrent_fence";

      // Migration writes the marker before its first NEW write.
      await writeRedirectMarker(prisma, { runId, reason: "live-migration" });

      // Two simulated old-side workers both consult the fence; both must back off.
      const [a, b] = await Promise.all([isFenced(prisma, runId), isFenced(prisma, runId)]);
      expect(a).toBe(true);
      expect(b).toBe(true);

      // ensureRedirectMarkerTable run again concurrently must not throw (idempotent DDL).
      await Promise.all([ensureRedirectMarkerTable(prisma), ensureRedirectMarkerTable(prisma)]);
    }
  );
});
