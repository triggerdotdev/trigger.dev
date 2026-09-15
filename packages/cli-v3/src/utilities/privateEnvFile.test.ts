import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateEnvFile } from "./privateEnvFile.js";

describe("writePrivateEnvFile", () => {
  it("creates private files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-env-"));
    const outputPath = join(directory, ".env.local");

    await writePrivateEnvFile(outputPath, "SECRET=value\n", "wx");

    expect(await readFile(outputPath, "utf8")).toBe("SECRET=value\n");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("creates private files in overwrite mode when the path is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-env-"));
    const outputPath = join(directory, ".env.local");

    await writePrivateEnvFile(outputPath, "SECRET=value\n", "w");

    expect(await readFile(outputPath, "utf8")).toBe("SECRET=value\n");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("does not replace an existing file in exclusive mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-env-"));
    const outputPath = join(directory, ".env.local");
    await writeFile(outputPath, "old=value\n");

    await expect(writePrivateEnvFile(outputPath, "SECRET=value\n", "wx")).rejects.toMatchObject({
      code: "EEXIST",
    });

    expect(await readFile(outputPath, "utf8")).toBe("old=value\n");
  });

  it("tightens an existing file before replacing its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-env-"));
    const outputPath = join(directory, ".env.local");
    await writeFile(outputPath, "old=value\n", { mode: 0o644 });
    await chmod(outputPath, 0o644);

    await writePrivateEnvFile(outputPath, "SECRET=value\n", "w");

    expect(await readFile(outputPath, "utf8")).toBe("SECRET=value\n");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("preserves symlinks while tightening and replacing their target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-env-"));
    const targetPath = join(directory, "target.env");
    const outputPath = join(directory, ".env.local");
    await writeFile(targetPath, "old=value\n", { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, outputPath);

    await writePrivateEnvFile(outputPath, "SECRET=value\n", "w");

    expect(await readFile(targetPath, "utf8")).toBe("SECRET=value\n");
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
  });
});
