import dotenv from "dotenv";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareEnvFile, readEnvVariable, trimSecret, upsertEnvLine } from "./envFile.js";
import { parseGracePeriod } from "./gracePeriod.js";

describe("upsertEnvLine", () => {
  it("appends, adding a missing newline", () => {
    expect(upsertEnvLine("", "S", "abc123")).toBe("S=abc123\n");
    expect(upsertEnvLine("A=1", "S", "2")).toBe("A=1\nS=2\n");
  });

  it("replaces an existing value in place without touching a variable that shares its prefix", () => {
    expect(upsertEnvLine("A=1\nB=old\nBB=keep\n", "B", "new")).toBe("A=1\nB=new\nBB=keep\n");
    expect(upsertEnvLine("export B=old\n", "B", "new")).toBe("B=new\n");
  });

  it("removes every assignment, so dotenv doesn't keep reading an old duplicate", () => {
    const out = upsertEnvLine("S=old1\nA=1\nS=old2\n", "S", "whsec_new");
    expect(dotenv.parse(out)).toEqual({ S: "whsec_new", A: "1" });
  });

  it("removes a quoted multi-line value without leaving its continuation lines behind", () => {
    const out = upsertEnvLine('S="old\nOTHER=inside\nend"\nA=1\n', "S", "whsec_new");
    expect(dotenv.parse(out)).toEqual({ S: "whsec_new", A: "1" });
  });

  it("leaves an assignment-shaped line inside another variable's quoted value alone", () => {
    expect(
      dotenv.parse(upsertEnvLine('OTHER="hello\nS=inside\nworld"\nS=old\n', "S", "new"))
    ).toEqual({
      OTHER: "hello\nS=inside\nworld",
      S: "new",
    });
    expect(dotenv.parse(upsertEnvLine('S=old\nA="before\nS=inside\nafter"\n', "S", "new"))).toEqual(
      {
        S: "new",
        A: "before\nS=inside\nafter",
      }
    );
  });

  it("quotes values that dotenv would otherwise read back truncated", () => {
    expect(dotenv.parse(upsertEnvLine("", "S", "has space#hash"))).toEqual({ S: "has space#hash" });
  });
});

describe("env files on disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webhook-secret-"));
  });

  afterEach(async () => {
    delete process.env.TEST_WEBHOOK_SECRET_FROM_ENV;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the process env first, then .env files with later files winning", async () => {
    await writeFile(join(dir, ".env"), "S=base\nTEST_WEBHOOK_SECRET_FROM_ENV=file\n");
    await writeFile(join(dir, ".env.local"), "S=local\n");
    process.env.TEST_WEBHOOK_SECRET_FROM_ENV = "process";
    expect(await readEnvVariable("TEST_WEBHOOK_SECRET_FROM_ENV", undefined, dir)).toBe("process");
    expect(await readEnvVariable("S", undefined, dir)).toBe("local");
    expect(await readEnvVariable("S", ".env", dir)).toBe("base");
    expect(await readEnvVariable("MISSING", undefined, dir)).toBeUndefined();
  });

  it("rejects a destination in a missing directory before anything is rotated", async () => {
    await expect(prepareEnvFile("missing/secret.env", dir)).rejects.toThrow("doesn't exist");
    await expect(prepareEnvFile(".env.local", dir)).resolves.toBe(join(dir, ".env.local"));
  });

  it("rejects a symlinked destination that could point at a tracked or shared file", async () => {
    await mkdir(join(dir, "shared"));
    await writeFile(join(dir, "shared", "config.env"), "");
    await symlink(join(dir, "shared", "config.env"), join(dir, ".env.local"));
    await expect(prepareEnvFile(".env.local", dir)).rejects.toThrow("symlink");
  });
});

describe("parseGracePeriod", () => {
  it("accepts seconds and durations, and refuses anything past the 7 day cap", () => {
    expect(parseGracePeriod("0")).toBe(0);
    expect(parseGracePeriod("3600")).toBe(3600);
    expect(parseGracePeriod("24h")).toBe(86400);
    expect(parseGracePeriod("7d")).toBe(604800);
    expect(() => parseGracePeriod("8d")).toThrow("up to 7d");
    expect(parseGracePeriod("1d12h")).toBe(129600);
    expect(() => parseGracePeriod("soon")).toThrow("up to 7d");
    expect(() => parseGracePeriod("1h2h")).toThrow("up to 7d");
    expect(parseGracePeriod("1hr30m")).toBe(5400);
    expect(() => parseGracePeriod("1h1hr")).toThrow("up to 7d");
  });
});

describe("trimSecret", () => {
  it("drops the newline a pipe adds, so it isn't stored as part of the secret", () => {
    expect(trimSecret("whsec_abc\r\n")).toBe("whsec_abc");
  });
});
