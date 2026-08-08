import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `chats.messages` is retired, not dropped: the transcript lives in `chat_messages`, one
 * row per message, and the column stays declared so whatever a deployed environment
 * already wrote remains readable.
 *
 * Retired means nothing reads or writes it. The column being declared is exactly why this
 * scan matters — the compiler no longer refuses a reference to it, in Drizzle or in raw
 * SQL. Zero hits today is the point; the test exists so a reintroduction is caught rather
 * than deployed.
 */

const ROOT = path.resolve(__dirname, "../../..");

const SCANNED = [
  "apps/webapp/app",
  "internal-packages/dashboard-agent/src",
  "internal-packages/dashboard-agent-db/src",
];

/**
 * A tripwire, not a proof. It does not see SQL assembled from separate fragments, queries
 * outside the scanned directories, anything run by hand or by an external tool, or an
 * aliased table (`from chats c … c.messages`). Migrations are skipped on purpose.
 */

/** A qualified reference to the retired column, in any of the spellings Postgres accepts. */
const QUALIFIED = /"?\bchats"?\s*\.\s*"?messages"?/i;

/** An unqualified one, inside a literal that is plainly SQL against `chats`. */
const SQL_LITERAL = /`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const SQL_VERB = /\b(select|insert\s+into|update|delete\s+from)\b/i;
// The quote is part of the match, not excluded before it: a schema-qualified
// `"trigger_dashboard_agent"."chats"` has a `"` immediately before the name.
const NAMES_CHATS = /(?<!\w)"?chats\b"?/i;
// No leading `\w`, so `chat_messages` is not a hit.
const BARE_MESSAGES = /(?<!\w)"?messages\b"?/i;

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

function offencesForText(text: string, label: string): string[] {
  const found: string[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (QUALIFIED.test(line)) found.push(`${label}:${index + 1} ${line.trim()}`);
  }

  for (const literal of text.match(SQL_LITERAL) ?? []) {
    if (!SQL_VERB.test(literal) || !NAMES_CHATS.test(literal)) continue;
    if (!BARE_MESSAGES.test(literal)) continue;
    found.push(`${label} (sql literal) ${literal.slice(0, 120)}`);
  }

  return found;
}

function offences(file: string): string[] {
  return offencesForText(readFileSync(file, "utf8"), path.relative(ROOT, file));
}

describe("the retired chats.messages column", () => {
  it("is not referenced by any production source, including in raw SQL", () => {
    const files = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
    // A scan that found nothing to read would pass vacuously.
    expect(files.length).toBeGreaterThan(200);

    expect(files.flatMap(offences)).toEqual([]);
  });

  // Without these the scan could rot into a pass-everything no-op.
  it("catches a schema-qualified update of the column", () => {
    expect(
      offencesForText(
        'sql`UPDATE "trigger_dashboard_agent"."chats" SET "messages" = ${value} WHERE "id" = ${chatId}`',
        "fixture"
      )
    ).not.toEqual([]);
  });

  it("catches an unqualified update, and leaves chat_messages alone", () => {
    expect(offencesForText("sql`update chats set messages = ${next}`", "fixture")).not.toEqual([]);
    expect(
      offencesForText("sql`insert into chat_messages (message) values (${row})`", "fixture")
    ).toEqual([]);
  });
});
