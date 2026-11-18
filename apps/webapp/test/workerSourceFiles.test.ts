import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ServiceValidationError } from "~/v3/services/common.server";
import {
  assertSourceFilesWithinLimits,
  createBoundedReadQueue,
  decodeWorkerSource,
  inflateSourceFilesForResponse,
  inflateWithin,
  jsonEscapedLength,
  measureInflatedSize,
  sourceForPrompt,
  WorkerSourceTooLargeError,
} from "~/v3/workerSourceFiles.server";

const MiB = 1024 * 1024;
const limits = { perFileBytes: 1 * MiB, totalBytes: 2 * MiB };

function source(text: string | Buffer) {
  return deflateSync(text).toString("base64");
}

function stored(base64: string) {
  return { contents: Buffer.from(base64, "utf-8") };
}

function filled(bytes: number, char = "a") {
  return Buffer.alloc(bytes, char);
}

describe("jsonEscapedLength", () => {
  // Catches: the size counter drifting from what the read API actually sends.
  it("matches the UTF-8 length of the JSON-encoded string", () => {
    const text = 'const s = "a\\b";\n\t\r\u0000\u001f\b\f é 漢字 😀  ';
    const bytes = Buffer.from(text, "utf-8");
    expect(jsonEscapedLength(bytes)).toBe(Buffer.byteLength(JSON.stringify(text)) - 2);
  });
});

describe("measureInflatedSize", () => {
  // Catches: the upload check buffering a huge file instead of stopping at the limit.
  it("stops a huge file early without buffering it", async () => {
    const huge = decodeWorkerSource(source(filled(512 * MiB)));
    const before = process.memoryUsage().arrayBuffers;
    const started = Date.now();

    const error = await measureInflatedSize(huge, MiB, 4 * MiB).catch((e) => e);

    expect(error).toBeInstanceOf(WorkerSourceTooLargeError);
    expect(error.limit).toBe("file");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MiB);
  });
});

describe("inflateWithin", () => {
  // Catches: an off-by-one that refuses a file exactly at the limit.
  it("accepts output exactly at the limit and refuses one byte more", async () => {
    expect((await inflateWithin(decodeWorkerSource(source(filled(MiB))), MiB)).length).toBe(MiB);
    await expect(
      inflateWithin(decodeWorkerSource(source(filled(MiB + 1))), MiB)
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });
});

describe("assertSourceFilesWithinLimits", () => {
  // Catches: an oversized file being accepted, or refused without naming the file.
  it("names the file and the per-file limit", async () => {
    const error = await assertSourceFilesWithinLimits(
      [
        { filePath: "src/ok.ts", contents: source("ok") },
        { filePath: "src/huge.ts", contents: source(filled(64 * MiB)) },
      ],
      limits
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error.status).toBe(413);
    expect(error.message).toContain('"src/huge.ts"');
    expect(error.message).toContain("1 MiB");
  });

  // Catches: many files under the per-file limit adding up to an unbounded total.
  it("refuses files under the per-file limit that add up past the total", async () => {
    const files = [1, 2, 3].map((n) => ({
      filePath: `src/${n}.ts`,
      contents: source(filled(900 * 1024)),
    }));

    const error = await assertSourceFilesWithinLimits(files, limits).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error.status).toBe(413);
    expect(error.message).toContain("2 MiB");
    expect(error.message).toContain('"src/3.ts"');
  });

  // Catches: stored rows that no reader can inflate.
  it("refuses contents that aren't valid compressed data", async () => {
    const error = await assertSourceFilesWithinLimits(
      [{ filePath: "src/raw.ts", contents: "ZXhwb3J0IGNvbnN0IGEgPSAxOw==" }],
      limits
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error.status).toBe(400);
    expect(error.message).toContain('"src/raw.ts"');
  });

  // Catches: invalid UTF-8, which grows 3x once decoded on read, getting past the total.
  it("refuses contents that aren't valid UTF-8", async () => {
    for (const bytes of [Buffer.alloc(1024, 0xff), Buffer.from([0x61, 0xc3])]) {
      const error = await assertSourceFilesWithinLimits(
        [{ filePath: "src/bin.ts", contents: source(bytes) }],
        limits
      ).catch((e) => e);

      expect(error).toBeInstanceOf(ServiceValidationError);
      expect(error.status).toBe(400);
      expect(error.message).toContain('"src/bin.ts"');
    }
  });

  // Catches: an empty last file skipping the total check, so read refuses what upload accepted.
  it("counts an empty file against the total", async () => {
    const tight = { perFileBytes: 100, totalBytes: 100 };
    const files = [
      { filePath: "src/a.ts", contents: source("a".repeat(98)) },
      { filePath: "src/empty.ts", contents: source("") },
    ];

    await expect(assertSourceFilesWithinLimits(files, tight)).rejects.toBeInstanceOf(
      ServiceValidationError
    );
    await expect(
      inflateSourceFilesForResponse(
        files.map((f) => stored(f.contents)),
        tight
      )
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });

  // Catches: upload and read measuring the total differently, so an accepted worker can't be read.
  it("accepts exactly what the read API can return", async () => {
    // Quote-heavy source grows when escaped: ~0.9 MiB raw per file, ~1.35 MiB escaped.
    const quoted = Buffer.from('"a",'.repeat(240 * 1024));
    const files = [1, 2].map((n) => ({ filePath: `src/${n}.ts`, contents: source(quoted) }));

    await expect(assertSourceFilesWithinLimits(files.slice(0, 1), limits)).resolves.toBeUndefined();
    await expect(
      inflateSourceFilesForResponse(
        files.slice(0, 1).map((f) => stored(f.contents)),
        limits
      )
    ).resolves.toHaveLength(1);

    await expect(assertSourceFilesWithinLimits(files, limits)).rejects.toBeInstanceOf(
      ServiceValidationError
    );
    await expect(
      inflateSourceFilesForResponse(
        files.map((f) => stored(f.contents)),
        limits
      )
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });
});

describe("inflateSourceFilesForResponse", () => {
  // Catches: a stored row from before the upload check being inflated without a limit.
  it("refuses a stored file past the per-file limit", async () => {
    await expect(
      inflateSourceFilesForResponse([stored(source(filled(64 * MiB)))], limits)
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });

  // Catches: control characters growing 6x in the response past the per-worker limit.
  it("counts JSON-escaped size against the total", async () => {
    // 400 KiB of NUL bytes is 2.4 MiB once escaped as \u0000.
    await expect(
      inflateSourceFilesForResponse([stored(source(Buffer.alloc(400 * 1024)))], limits)
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });
});

describe("inflateSourceFilesForResponse invalid UTF-8", () => {
  // Catches: a stored row with invalid bytes counted at 1 byte each but sent as 3.
  it("counts what invalid bytes grow to once decoded", async () => {
    // 800 KiB of 0xFF is under the per-file limit but 2.4 MiB once each byte becomes U+FFFD.
    await expect(
      inflateSourceFilesForResponse([stored(source(Buffer.alloc(800 * 1024, 0xff)))], limits)
    ).rejects.toBeInstanceOf(WorkerSourceTooLargeError);
  });
});

describe("createBoundedReadQueue", () => {
  const lease = (signal = new AbortController().signal, onHoldExpired?: () => void) => ({
    signal,
    onHoldExpired,
  });

  // Catches: an unbounded queue, and abandoned requests still taking the single slot.
  it("refuses reads past the waiting limit and skips reads whose client has gone", async () => {
    const queue = createBoundedReadQueue({ concurrency: 1, maxPending: 2, maxHoldMs: 60_000 });
    const firstSent = new AbortController();
    const gone = new AbortController();
    let skippedReadRan = false;

    const first = queue.run(lease(firstSent.signal), async () => "first");
    await new Promise((resolve) => setImmediate(resolve)); // let the first read take the slot
    const second = queue.run(lease(gone.signal), async () => {
      skippedReadRan = true;
      return "second";
    });
    const third = queue.run(lease(), async () => "third");
    await expect(queue.run(lease(), async () => "fourth")).resolves.toEqual({ status: "busy" });

    gone.abort();
    firstSent.abort();

    await expect(first).resolves.toEqual({ status: "done", value: "first" });
    await expect(second).resolves.toEqual({ status: "aborted" });
    await expect(third).resolves.toEqual({ status: "done", value: "third" });
    expect(skippedReadRan).toBe(false);
  });

  // Catches: a maxPending of 0 refusing every read, even on an idle process.
  it("admits a read into a free slot with no waiting allowed, and refuses one that would wait", async () => {
    const queue = createBoundedReadQueue({ concurrency: 1, maxPending: 0, maxHoldMs: 60_000 });
    const firstSent = new AbortController();

    const first = queue.run(lease(firstSent.signal), async () => "first");
    await expect(queue.run(lease(), async () => "second")).resolves.toEqual({ status: "busy" });

    firstSent.abort();
    await expect(first).resolves.toEqual({ status: "done", value: "first" });
  });

  // Catches: the slot being freed before the response is sent, so slow clients pile up bodies.
  it("keeps the slot until the response is sent", async () => {
    const queue = createBoundedReadQueue({ concurrency: 1, maxPending: 10, maxHoldMs: 60_000 });
    const firstSent = new AbortController();
    let secondStarted = false;

    await expect(queue.run(lease(firstSent.signal), async () => "first")).resolves.toEqual({
      status: "done",
      value: "first",
    });
    const second = queue.run(lease(), async () => {
      secondStarted = true;
      return "second";
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    firstSent.abort();
    await expect(second).resolves.toEqual({ status: "done", value: "second" });
  });

  // Catches: a client that never reads holding the slot forever.
  it("drops a client that hasn't taken its response within the hold limit", async () => {
    const queue = createBoundedReadQueue({ concurrency: 1, maxPending: 10, maxHoldMs: 50 });
    const events: string[] = [];
    let onDropped!: () => void;
    const dropped = new Promise<void>((resolve) => (onDropped = resolve));

    await queue.run(
      lease(undefined, () => {
        events.push("dropped");
        onDropped();
      }),
      async () => "slow"
    );
    const next = queue.run(lease(), async () => {
      events.push("next started");
      return "next";
    });

    await dropped;
    await expect(next).resolves.toEqual({ status: "done", value: "next" });
    expect(events).toEqual(["dropped", "next started"]);
  });
});

describe("sourceForPrompt", () => {
  // Catches: a whole large file being sent to the model.
  it("returns a small file whole and cuts a large one with a note", async () => {
    await expect(
      sourceForPrompt(stored(source("export const a = 1;")).contents, 100)
    ).resolves.toBe("export const a = 1;");
    const out = await sourceForPrompt(stored(source("x".repeat(500))).contents, 100);
    expect(out).toBe(
      `${"x".repeat(100)}\n\n[Truncated: showing the first 100 bytes of this file.]`
    );
  });

  // Catches: the AI action inflating a whole huge file to keep only its first bytes.
  it("stops a huge file at the prompt budget without buffering it", async () => {
    const huge = stored(source(filled(512 * MiB))).contents;
    const before = process.memoryUsage().arrayBuffers;
    const started = Date.now();

    const out = await sourceForPrompt(huge, 1024);

    expect(out.startsWith("a".repeat(1024) + "\n\n[Truncated")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MiB);
  });

  // Catches: a multi-byte character cut at the budget turning into garbage.
  it("doesn't split a multi-byte character at the cut", async () => {
    const out = await sourceForPrompt(stored(source("é".repeat(100))).contents, 5);
    expect(out.startsWith("éé\n\n[Truncated")).toBe(true);
  });
});
