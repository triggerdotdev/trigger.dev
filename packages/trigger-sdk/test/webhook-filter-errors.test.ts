import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The editor message for an invalid filter, match or startOn must be the validator's own `✖ ...`
 * text. `@ts-expect-error` passes on any error, so these compile a consumer file against the SDK
 * source with the package's tsc and assert the diagnostic text at each call.
 */

const packageRoot = resolve(__dirname, "..");
const src = (path: string) => JSON.stringify(join(packageRoot, "src", path));

const HEADER = `
import { chat } from ${src("v3/ai.js")};
import { webhook, webhooks, type ChatEvent } from ${src("v3/webhooks.js")};
import type Stripe from "stripe";

type Event = { type: "checkout.session.completed" | "invoice.paid"; amount: number };
const endpoint = webhooks.endpoint.define({ id: "filter-errors", source: webhooks.stripe<Event>() });
const onEvent = async () => {};
const inbound = () => ({ message: { role: "user" as const, parts: [] } }) as never;

type Union =
  | { type: "payment_intent.succeeded"; data: { object: { amount: number } } }
  | { type: "customer.created"; data: { object: { email: string } } };
const union = webhooks.endpoint.define({ id: "narrowing", source: webhooks.stripe<Union>() });
const payments = webhooks.endpoint.define({ id: "stripe-events", source: webhooks.stripe<Stripe.Event>() });
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type EventOf<E> = E extends ChatEvent<string, infer T> ? T : never;
type PaymentSucceeded = Extract<Union, { type: "payment_intent.succeeded" }>;
type Mixed = { kind: "text"; value: string } | { kind: "number"; value: number } | { kind: "flag"; value: boolean };
type Nullable = { kind: "set"; value: string } | { kind: "unset"; value: null };
const nullable = webhooks.endpoint.define({ id: "nullable", source: webhooks.stripe<Nullable>() });
type NullableCount = { kind: "count"; value: number } | { kind: "unset"; value: null };
const nullableCount = webhooks.endpoint.define({
  id: "nullable-count",
  source: webhooks.stripe<NullableCount>(),
});
const mixed = webhooks.endpoint.define({ id: "mixed", source: webhooks.stripe<Mixed>() });
type IssueComment = { action: string; issue: { number: number; pull_request?: { url: string } | null; title: string } };
const comments = webhooks.endpoint.define({ id: "comments", source: webhooks.github<IssueComment>() });
`;

const BAD_LITERAL = "event.type == 'checkout.session.complete'";
const BAD_FIELD = "event.missing == 1";
const UNBALANCED = "( event.amount >= 1";
const VALID = "event.type == 'invoice.paid' && event.amount >= 10";

const LITERAL_MESSAGE = "✖ value 'checkout.session.complete' is not valid for event.type";
const FIELD_MESSAGE = "✖ unknown field: event.missing";
const PARENS_MESSAGE = '✖ unbalanced parens (missing \\")\\")';

const CASES: Array<{ name: string; code: string; message?: string }> = [
  {
    name: "webhook() bad literal",
    code: `webhook({ id: "a", endpoint, onEvent, filter: "${BAD_LITERAL}" });`,
    message: LITERAL_MESSAGE,
  },
  {
    name: "webhook() unknown field",
    code: `webhook({ id: "b", endpoint, onEvent, filter: "${BAD_FIELD}" });`,
    message: FIELD_MESSAGE,
  },
  {
    name: "webhook() unbalanced parens",
    code: `webhook({ id: "c", endpoint, onEvent, filter: "${UNBALANCED}" });`,
    message: PARENS_MESSAGE,
  },
  {
    name: "chat.event() bad literal",
    code: `chat.event({ id: "d", endpoint, key: "{event.type}", filter: "${BAD_LITERAL}" });`,
    message: LITERAL_MESSAGE,
  },
  {
    name: "chat.event() unknown field",
    code: `chat.event({ id: "e", endpoint, key: "{event.type}", filter: "${BAD_FIELD}" });`,
    message: FIELD_MESSAGE,
  },
  {
    name: "chat.event() unbalanced parens",
    code: `chat.event({ id: "f", endpoint, key: "{event.type}", filter: "${UNBALANCED}" });`,
    message: PARENS_MESSAGE,
  },
  {
    name: "waiter filter",
    code: `void webhooks.waiter.create(endpoint, { filter: "${BAD_LITERAL}" });`,
    message: LITERAL_MESSAGE,
  },
  {
    name: "waiter match",
    code: `void webhooks.waiter.create(endpoint, { match: { "event.missing": "x" } });`,
    message: "✖ unknown event path: missing",
  },
  {
    name: "custom channel filter",
    code: `chat.channels.custom({ id: "g", endpoint, key: "{event.type}", inbound, filter: "${BAD_FIELD}" });`,
    message: FIELD_MESSAGE,
  },
  {
    name: "custom channel startOn",
    code: `chat.channels.custom({ id: "h", endpoint, key: "{event.type}", inbound, startOn: "${UNBALANCED}" });`,
    message: PARENS_MESSAGE,
  },
  {
    name: "chat.event() key with an unknown event path",
    code: `chat.event({ id: "m", endpoint, key: "{event.missing}" });`,
    message: "✖ unknown event path: missing",
  },
  {
    name: "chat.event() key without a namespace",
    code: `chat.event({ id: "n", endpoint, key: "{order.id}" });`,
    message: "✖ key paths start with event., header. or webhook.: order.id",
  },
  {
    name: "custom channel key with an unknown event path",
    code: `chat.channels.custom({ id: "o", endpoint, key: "{event.nope}", inbound });`,
    message: "✖ unknown event path: nope",
  },
  {
    name: "valid filters still compile",
    code: `webhook({ id: "i", endpoint, onEvent, filter: "${VALID}" }); chat.event({ id: "j", endpoint, key: "{event.type}", filter: "${VALID}" }); void webhooks.waiter.create(endpoint, { filter: "${VALID}", match: { "event.type": "invoice.paid" } });`,
  },
  {
    name: "a filter built at runtime compiles and is checked by the server",
    code: `const computed: string = ["event.amount >= 1"].join(" && "); webhook({ id: "r", endpoint, onEvent, filter: computed }); chat.event({ id: "s", endpoint, key: "{event.type}", filter: computed }); chat.channels.custom({ id: "t", endpoint, key: "{event.type}", inbound, filter: computed, startOn: computed });`,
  },
  {
    name: "valid keys still compile",
    code: `chat.event({ id: "p", endpoint, key: "{webhook.externalRef}:{event.type || header.x-id}" }); chat.channels.custom({ id: "q", endpoint, key: "{event.type}:{event.amount}", inbound });`,
  },
  {
    name: "an event.type clause narrows the fields after it",
    code: `webhook({ id: "u1", endpoint: union, filter: "event.type == 'payment_intent.succeeded' && event.data.object.amount >= 10000", onEvent });`,
  },
  {
    name: "a field the selected member lacks is still unknown",
    code: `webhook({ id: "u2", endpoint: union, filter: "event.type == 'customer.created' && event.data.object.amount >= 1", onEvent });`,
    message: "✖ unknown field: event.data.object.amount",
  },
  {
    name: "a field only some union members have is accepted without a type clause",
    code: `webhook({ id: "u3", endpoint: union, filter: "event.data.object.amount >= 1", onEvent });`,
  },
  {
    name: "parens may touch their operands",
    code: `webhook({ id: "u4", endpoint: union, filter: "(event.type == 'customer.created' || event.type == 'payment_intent.succeeded') && (event.data.object.amount >= 1)", onEvent });`,
  },
  {
    name: "a long in list narrows without hitting the instantiation depth limit",
    code: `webhook({ id: "u11", endpoint: union, filter: "event.type in [${Array(60).fill("'customer.created'").join(",")}]", onEvent: async ({ event }) => { void event.data.object.email; } });`,
  },
  {
    name: "narrowing keeps members the server's coercing == can match",
    code: `webhook({ id: "u12", endpoint: mixed, filter: "event.value in [1,'true']", onEvent: async ({ event }) => { const ok: Exact<typeof event, Mixed> = true; void ok; } }); webhook({ id: "u13", endpoint: mixed, filter: "event.value == true", onEvent: async ({ event }) => { const ok: Exact<typeof event["kind"], "flag"> = true; void ok; } });`,
  },
  {
    name: "narrowing keeps a null field the server's == matches for 'null' and 0",
    code: `webhook({ id: "u14", endpoint: nullable, filter: "event.value == 'a'", onEvent: async ({ event }) => { const ok: Exact<typeof event["kind"], "set"> = true; void ok; } }); webhook({ id: "u15", endpoint: mixed, filter: "event.value in [0]", onEvent: async ({ event }) => { const ok: Exact<typeof event, Mixed> = true; void ok; } }); webhook({ id: "u16", endpoint: nullable, filter: "event.value == 'null'", onEvent: async ({ event }) => { const ok: Exact<typeof event, Nullable> = true; void ok; } });`,
  },
  {
    name: "== null and != null check an optional or nullable field's presence",
    code: `webhook({ id: "n1", endpoint: comments, filter: "event.issue.pull_request != null", onEvent }); chat.event({ id: "n2", endpoint: comments, key: "{event.issue.number}", filter: "event.issue.pull_request.url == null" }); webhook({ id: "n3", endpoint: nullable, filter: "event.value == null", onEvent });`,
  },
  {
    name: "null is accepted on a required field and inside an in list",
    code: `webhook({ id: "n4", endpoint: comments, filter: "event.issue.title != null && event.action in ['created', null]", onEvent });`,
  },
  {
    name: "a zero written as 0.0 or -0 keeps a null field too",
    code: `webhook({ id: "u17", endpoint: nullableCount, filter: "event.value == 0.0", onEvent: async ({ event }) => { const ok: Exact<typeof event, NullableCount> = true; void ok; } }); webhook({ id: "u18", endpoint: nullableCount, filter: "event.value in [-0]", onEvent: async ({ event }) => { const ok: Exact<typeof event, NullableCount> = true; void ok; } }); webhook({ id: "u19", endpoint: nullableCount, filter: "event.value == 5", onEvent: async ({ event }) => { const ok: Exact<typeof event["kind"], "count"> = true; void ok; } });`,
  },
  {
    name: "onEvent gets the event the filter selects",
    code: `webhook({ id: "u5", endpoint: union, filter: "event.type == 'payment_intent.succeeded'", onEvent: async ({ event }) => { const amount: number = event.data.object.amount; void amount; } });`,
  },
  {
    name: "onEvent gets the union of an || of type clauses",
    code: `webhook({ id: "u6", endpoint: union, filter: "event.type in ['customer.created','payment_intent.succeeded'] && event.data.object.amount > 1", onEvent: async ({ event }) => { const ok: Exact<typeof event, Union> = true; void ok; } });`,
  },
  {
    name: "onEvent keeps the whole union when a branch doesn't narrow",
    code: `webhook({ id: "u7", endpoint: union, filter: "event.type == 'customer.created' || event.data.object.amount >= 1", onEvent: async ({ event }) => { void event.data.object.email; } });`,
    message: "Property 'email' does not exist",
  },
  {
    name: "triggering a narrowed webhook by hand needs a matching event",
    code: `void webhook({ id: "u8", endpoint: union, filter: "event.type == 'payment_intent.succeeded'", onEvent }).trigger({ event: { type: "customer.created", data: { object: { email: "a" } } } });`,
    message: `'"customer.created"' is not assignable to type '"payment_intent.succeeded"'`,
  },
  {
    name: "chat.event() narrows its action event",
    code: `const narrowedEvent = chat.event({ id: "u9", endpoint: union, key: "{event.type}", filter: "event.type == 'payment_intent.succeeded'" }); const narrowedOk: Exact<EventOf<typeof narrowedEvent>, PaymentSucceeded> = true; void narrowedOk;`,
  },
  {
    name: "custom channel callbacks get the narrowed event",
    code: `chat.channels.custom({ id: "u10", endpoint: union, key: "{event.type}", filter: "event.type == 'payment_intent.succeeded'", inbound: (event) => { void event.data.object.amount; return inbound(); } });`,
  },
  {
    name: "a waiter's event is narrowed by its filter",
    code: `void webhooks.waiter.create(union, { filter: "event.type == 'payment_intent.succeeded'" }).then(async (waiter) => { const { event } = await webhooks.waiter.wait(waiter).unwrap(); const amount: number = event.data.object.amount; void amount; });`,
  },
  {
    name: "Stripe.Event narrows to the selected event",
    code: `webhook({ id: "s1", endpoint: payments, filter: "event.type == 'checkout.session.completed' && event.data.object.amount_total >= 100", onEvent: async ({ event }) => { const session: Stripe.Checkout.Session = event.data.object; void session; } });`,
  },
  {
    name: "Stripe.Event rejects a field the selected event lacks",
    code: `webhook({ id: "s2", endpoint: payments, filter: "event.type == 'invoice.paid' && event.data.object.client_secret startsWith 'pi_'", onEvent });`,
    message: "✖ unknown field: event.data.object.client_secret",
  },
  {
    name: "chat.event() key resolves against the filtered Stripe event",
    code: `chat.event({ id: "s3", endpoint: payments, key: "{event.data.object.client_reference_id}", filter: "event.type == 'checkout.session.completed'" });`,
  },
  {
    name: "omitted filters still compile",
    code: `webhook({ id: "k", endpoint, onEvent }); chat.event({ id: "l", endpoint, key: "{event.type}" }); void webhooks.waiter.create(endpoint);`,
  },
];

function diagnosticsByLine(): Map<number, string[]> {
  const dir = mkdtempSync(join(packageRoot, ".filter-errors-"));
  try {
    writeFileSync(join(dir, "consumer.ts"), `${HEADER}\n${CASES.map((c) => c.code).join("\n")}\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(packageRoot, "tsconfig.json"),
        compilerOptions: {
          noEmit: true,
          composite: false,
          incremental: false,
          rootDir: "..",
          types: ["node"],
        },
        include: ["consumer.ts", "../src/globals.d.ts"],
      })
    );
    const result = spawnSync(
      join(packageRoot, "node_modules/.bin/tsc"),
      ["-p", dir, "--pretty", "false"],
      {
        encoding: "utf8",
      }
    );
    const byLine = new Map<number, string[]>();
    let last: number | undefined;
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      const match = /^(.*?)\((\d+),\d+\): error TS\d+: (.*)$/.exec(line);
      if (match) {
        last = match[1]!.endsWith("consumer.ts") ? Number(match[2]) - 1 : -1;
        byLine.set(last, [...(byLine.get(last) ?? []), match[3]!]);
      } else if (last !== undefined && line.startsWith(" ")) {
        byLine.get(last)!.push(line.trim());
      }
    }
    return byLine;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("webhook filter error messages", () => {
  const headerLines = `${HEADER}\n`.split("\n").length - 1;
  let byLine: Map<number, string[]>;
  const at = (index: number) => byLine.get(headerLines + index) ?? [];

  it("compiles the consumer file", () => {
    byLine = diagnosticsByLine();
    const outside = [...byLine.entries()].filter(
      ([line]) => line < headerLines || line >= headerLines + CASES.length
    );
    expect(outside).toEqual([]);
  }, 120_000);

  for (const [index, testCase] of CASES.entries()) {
    it(testCase.name, () => {
      if (testCase.message) {
        expect(at(index).join("\n")).toContain(testCase.message);
      } else {
        expect(at(index)).toEqual([]);
      }
    });
  }
});
