import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `chats.messages` is gone: the transcript lives in `chat_messages`, one row per message.
 *
 * TypeScript already catches a reference through the Drizzle schema — the column isn't
 * there, so it doesn't compile. A raw-SQL reference compiles fine and fails at runtime,
 * which is the hole this scan covers. Zero hits today is the point; the test exists so a
 * reintroduction is caught rather than deployed.
 */

const ROOT = path.resolve(__dirname, "../../..");

const SCANNED = [
  "apps/webapp/app",
  "internal-packages/dashboard-agent/src",
  "internal-packages/dashboard-agent-db/src",
];

/** A qualified reference to the dropped column, in any of the spellings Postgres accepts. */
const QUALIFIED = /"?\bchats"?\s*\.\s*"?messages"?/i;

/** An unqualified one, inside a literal that is plainly SQL against `chats`. */
const SQL_LITERAL = /`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const SQL_VERB = /\b(select|insert\s+into|update|delete\s+from)\b/i;
const NAMES_CHATS = /(?<![\w."])chats\b/i;
// Word-boundary on both sides and no leading `_`, so `chat_messages` is not a hit.
const BARE_MESSAGES = /(?<![\w."])messages\b/i;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "drizzle") continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    // Tests are excluded: they are allowed to name the old column to describe it.
    if (/\.(test|eval|spec)\.tsx?$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

function offences(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (QUALIFIED.test(line))
      found.push(`${path.relative(ROOT, file)}:${index + 1} ${line.trim()}`);
  }

  for (const literal of text.match(SQL_LITERAL) ?? []) {
    if (!SQL_VERB.test(literal) || !NAMES_CHATS.test(literal)) continue;
    if (!BARE_MESSAGES.test(literal)) continue;
    found.push(`${path.relative(ROOT, file)} (sql literal) ${literal.slice(0, 120)}`);
  }

  return found;
}

describe("the dropped chats.messages column", () => {
  it("is not referenced by any production source, including in raw SQL", () => {
    const files = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
    // A scan that found nothing to read would pass vacuously.
    expect(files.length).toBeGreaterThan(200);

    expect(files.flatMap(offences)).toEqual([]);
  });
});
