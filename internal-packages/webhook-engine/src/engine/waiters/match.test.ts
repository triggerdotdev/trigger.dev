import { describe, expect, it } from "vitest";
import { eventValues, validateMatch, waiterShape } from "./match.js";

const ns = (body: unknown, header: Record<string, string> = {}) => ({
  body,
  header,
  webhook: {
    externalRef: "shop_1",
    tenantId: "tnt_1",
    id: "orders",
    source: "shopify",
    deliveryId: "dlv_1",
  },
});

describe("validateMatch", () => {
  it("accepts event, header and webhook paths with scalar values", () => {
    expect(
      validateMatch(
        {
          "event.data.object.id": "pi_1",
          "event.amount": 4200,
          "event.livemode": false,
          "header.x-shop-domain": "acme.myshopify.com",
          "header.x.dotted": "ok",
          "webhook.externalRef": "shop_1",
        },
        10
      )
    ).toBeUndefined();
    expect(validateMatch(undefined, 5)).toBeUndefined();
  });

  it("refuses a path without a namespace, suggesting the event path", () => {
    expect(validateMatch({ "data.object.id": "x" }, 5)).toBe(
      'match path "data.object.id" needs a namespace: use event.data.object.id for the event body, header.<name> or webhook.<field>'
    );
    expect(validateMatch({ "body.data.object.id": "x" }, 5)).toContain("use event.data.object.id");
    expect(validateMatch({ type: "x" }, 5)).toContain("use event.type");
  });

  it("refuses a bare namespace, an unknown endpoint field and a malformed path", () => {
    expect(validateMatch({ event: "x" }, 5)).toBe(
      'match path "event" needs a field after the namespace, like event.id'
    );
    expect(validateMatch({ "webhook.nope": "x" }, 5)).toContain("is not an endpoint field");
    expect(validateMatch({ "webhook.id.more": "x" }, 5)).toContain("is not an endpoint field");
    expect(validateMatch({ "event.a..b": "x" }, 5)).toBe(
      'match path "event.a..b" is not a valid dotted path'
    );
    expect(validateMatch({ "event.__proto__.x": "x" }, 5)).toContain("is not a valid dotted path");
  });

  it("refuses a non-scalar value and too many paths", () => {
    expect(validateMatch({ "event.a": { b: 1 } }, 5)).toBe(
      'match value at "event.a" must be a string, number or boolean'
    );
    expect(validateMatch({ "event.a": "1", "event.b": "2" }, 1)).toBe(
      "match has 2 paths; the limit is 1"
    );
  });
});

describe("eventValues", () => {
  it("reads event paths from the body, headers case-insensitively and endpoint fields", () => {
    const { paths } = waiterShape({
      "event.order.id": "o_1",
      "header.x-shop-domain": "acme",
      "webhook.externalRef": "shop_1",
    });
    expect(paths).toEqual(["event.order.id", "header.x-shop-domain", "webhook.externalRef"]);
    expect(eventValues(paths, ns({ order: { id: "o_1" } }, { "X-Shop-Domain": "acme" }))).toEqual([
      "o_1",
      "acme",
      "shop_1",
    ]);
  });

  it("does not read a body field named event through the namespace twice", () => {
    expect(eventValues(["event.event.ts"], ns({ event: { ts: "1.2" } }))).toEqual(["1.2"]);
    expect(eventValues(["event.ts"], ns({ event: { ts: "1.2" } }))).toBeUndefined();
  });

  it("stringifies scalars and misses on a missing or non-scalar value", () => {
    expect(eventValues(["event.n", "event.b"], ns({ n: 42, b: true }))).toEqual(["42", "true"]);
    expect(eventValues(["event.missing"], ns({}))).toBeUndefined();
    expect(eventValues(["event.obj"], ns({ obj: { a: 1 } }))).toBeUndefined();
  });

  it("matches the same values to the same key as the waiter's match", () => {
    const match = { "event.type": "paid", "event.order.id": "o_9" };
    const shape = waiterShape(match);
    const values = eventValues(shape.paths, ns({ type: "paid", order: { id: "o_9" } }));
    expect(values).toEqual(shape.paths.map((path) => String(match[path as keyof typeof match])));
  });
});
