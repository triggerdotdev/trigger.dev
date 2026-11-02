import dotenv from "dotenv";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DOTENV_FILES = [".env", ".env.development", ".env.local", ".env.development.local"];

export async function readEnvVariable(
  name: string,
  envFile?: string,
  cwd = process.cwd()
): Promise<string | undefined> {
  if (envFile) {
    return dotenv.parse(await readFile(resolve(cwd, envFile), "utf8"))[name];
  }

  if (process.env[name]) return process.env[name];

  let value: string | undefined;
  for (const file of DOTENV_FILES) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    value = dotenv.parse(await readFile(path, "utf8"))[name] ?? value;
  }
  return value;
}

/**
 * Sets `name` in .env content. Every existing assignment of `name` is removed, including the
 * continuation lines of a quoted multi-line value, and the new one takes the place of the first, so
 * dotenv reads the new value even when the file assigned the variable more than once. Lines inside
 * another variable's quoted value are kept as they are, even when they look like an assignment.
 */
export function upsertEnvLine(content: string, name: string, value: string): string {
  const line = `${name}=${quoteEnvValue(value)}`;
  const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
  const lines = content.split("\n");
  const out: string[] = [];
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    const match = assignment.exec(lines[i]!);
    if (!match) {
      out.push(lines[i]!);
      continue;
    }

    const last = lastLineOfValue(lines, i, match[2]!);
    if (match[1] === name) {
      if (!replaced) {
        out.push(line);
        replaced = true;
      }
    } else {
      out.push(...lines.slice(i, last + 1));
    }
    i = last;
  }

  if (replaced) return out.join("\n");

  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${line}\n`;
}

function lastLineOfValue(lines: string[], start: number, value: string): number {
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return start;
  if (value.indexOf(quote, 1) !== -1) return start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.includes(quote)) return i;
  }
  return start;
}

function quoteEnvValue(value: string): string {
  return /^[A-Za-z0-9_\-+/=.:]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Checks that `file` can take the secret before the endpoint's secret is rotated, so a bad
 * destination fails without changing anything. Refuses symlinks, which could point the secret at a
 * tracked or shared file.
 */
export async function prepareEnvFile(file: string, cwd = process.cwd()): Promise<string> {
  const path = resolve(cwd, file);
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (stats?.isSymbolicLink()) {
    throw new Error(`${file} is a symlink. Pass the file it points to with --to-file instead.`);
  }
  if (stats && !stats.isFile()) {
    throw new Error(`${file} isn't a file.`);
  }

  try {
    await access(
      stats ? path : dirname(path),
      stats ? constants.R_OK | constants.W_OK : constants.W_OK
    );
  } catch {
    throw new Error(
      stats
        ? `Can't read and write ${file}.`
        : `Can't create ${file}: ${dirname(path)} doesn't exist or isn't writable.`
    );
  }

  return path;
}

/** Writes the variable and reports whether other users can read the file. */
export async function saveToEnvFile(
  path: string,
  name: string,
  value: string
): Promise<{ readableByOthers: boolean }> {
  const content = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, upsertEnvLine(content, name, value), { mode: 0o600 });
  return { readableByOthers: ((await stat(path)).mode & 0o077) !== 0 };
}

/** Last resort when the destination write fails after rotating: a private temporary file. */
export async function saveToPrivateTempFile(name: string, value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trigger-webhook-secret-"));
  const path = join(dir, ".env");
  await writeFile(path, upsertEnvLine("", name, value), { mode: 0o600 });
  return path;
}

export function trimSecret(value: string): string {
  return value.replace(/\r?\n$/, "").trim();
}
