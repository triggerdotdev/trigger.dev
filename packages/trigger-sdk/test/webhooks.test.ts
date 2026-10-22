import "../src/v3/test/index.js";

import {
  type StripeWebhookEvent,
  type ValidatedWebhookKey,
  type ValidatedWebhookMatch,
  type ValidateWebhookFilter,
  resourceCatalog,
} from "@trigger.dev/core/v3";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { chatEvent, webhook, webhooks } from "../src/v3/webhooks.js";

describe("webhooks producers", () => {
  it("names a hyphenated provider in camel case and keeps the provider id on the source", () => {
    const source = webhooks.calCom();
    expect(source.provider).toBe("cal-com");
    expect(source.verifier.kind).toBe("config");
    expect((webhooks as unknown as Record<string, unknown>)["cal-com"]).toBeUndefined();
    expect(webhooks).not.toHaveProperty("zoom");
    expectTypeOf<"zoom">().not.toMatchTypeOf<keyof typeof webhooks>();
  });

  it("carries a shared-secret config and setup prompt from the provider table", () => {
    const supabase = webhooks.supabase();
    expect(supabase).toMatchObject({
      provider: "supabase",
      verifier: { kind: "config", config: { scheme: "shared-secret", placement: "bearer" } },
      secretProvisioning: "integrator",
    });
    expect(supabase.setupPrompt).toContain("Bearer <secret>");

    const loops = webhooks.loops();
    expect(loops.verifier).toMatchObject({
      kind: "config",
      config: { scheme: "hmac", signatureHeader: "webhook-signature" },
    });
    expect(loops.setupPrompt).toContain("whsec_");
  });
});

describe("webhooks.custom()", () => {
  it("refuses a url-secret placed in the path, which the hosted ingress cannot serve", () => {
    expect(() =>
      webhooks.custom({
        scheme: "url-secret",
        // @ts-expect-error path placement is excluded from the hosted config type
        placement: "path",
        paramName: "token",
      })
    ).toThrow(/placement "path"/);
    expect(
      webhooks.custom({ scheme: "url-secret", placement: "query", paramName: "token" }).provider
    ).toBe("custom");
  });

  it("carries a response contract, so a form provider can be answered with an empty 200", () => {
    const config = { scheme: "url-secret", placement: "query", paramName: "token" } as const;
    expect(webhooks.custom(config, { response: { acceptedBody: "empty" } }).verifier).toEqual({
      kind: "config",
      config,
      response: { acceptedBody: "empty" },
    });
    expect(webhooks.custom(config).verifier).not.toHaveProperty("response");
  });
});

describe("webhook() handle", () => {
  it("runs on the { event, headers } envelope, so a hand trigger reaches onEvent with the event", async () => {
    const seen: Array<{ event: unknown; eventHeader: string | null }> = [];
    const handle = webhook({
      id: "webhooks.test.handle",
      endpoint: webhooks.endpoint.define({
        id: "webhooks-test-handle",
        source: webhooks.custom<{ id: string }>({
          scheme: "hmac",
          algorithm: "sha256",
          encoding: "hex",
          signatureHeader: "x-sig",
          signingString: "raw",
        }),
      }),
      onEvent: async ({ event, headers }) => {
        seen.push({ event, eventHeader: headers.get("x-kind") });
      },
    });
    const entry = resourceCatalog.getTask(handle.id);
    expect(entry).toBeDefined();
    await entry!.fns.run({ event: { id: "evt_1" }, headers: { "x-kind": "ping" } }, {
      ctx: {} as never,
    } as never);
    await entry!.fns.run({ event: { id: "evt_2" } }, { ctx: {} as never } as never);
    expect(seen).toEqual([
      { event: { id: "evt_1" }, eventHeader: "ping" },
      { event: { id: "evt_2" }, eventHeader: null },
    ]);
  });
});

describe("webhook() task options", () => {
  it("passes queue, machine, retry and duration options through to the task", () => {
    const handle = webhook({
      id: "webhooks.test.task-options",
      endpoint: webhooks.endpoint.define({ id: "task-options", source: webhooks.stripe() }),
      queue: { concurrencyLimit: 1 },
      machine: "small-2x",
      retry: { maxAttempts: 2 },
      maxDuration: 120,
      onStart: async ({ payload }) => {
        void payload.event;
      },
      onEvent: async () => {},
    });
    const entry = resourceCatalog.getTask(handle.id);
    expect(entry?.triggerSource).toBe("webhook");
    expect(entry?.queue?.concurrencyLimit).toBe(1);
    expect(entry?.machine).toEqual({ preset: "small-2x" });
    expect(entry?.retry?.maxAttempts).toBe(2);
    expect(entry?.maxDuration).toBe(120);
  });
});

describe("webhook filter types", () => {
  it("accepts default provider payloads and open nested records", () => {
    webhook({
      id: "webhooks.test.stripe-filter",
      endpoint: webhooks.endpoint.define({ id: "stripe-filter", source: webhooks.stripe() }),
      filter: "event.data.object.amount >= 10000",
      onEvent: async () => {},
    });
    webhook({
      id: "webhooks.test.stripe-nested-filter",
      endpoint: webhooks.endpoint.define({ id: "stripe-nested-filter", source: webhooks.stripe() }),
      filter: "event.data.object.customer.name startsWith 'Jo'",
      onEvent: async () => {},
    });
    for (const source of [
      webhooks.svix(),
      webhooks.square(),
      webhooks.discord(),
      webhooks.retell(),
    ]) {
      webhook({
        id: `webhooks.test.${source.provider}-filter`,
        endpoint: webhooks.endpoint.define({ id: `${source.provider}-filter`, source }),
        filter: "event.type == 'created'",
        onEvent: async () => {},
      });
    }
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.items any ( amount >= 100 )">
    >().toEqualTypeOf<"event.items any ( amount >= 100 )">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.amount >= event.minimum">
    >().toEqualTypeOf<"event.amount >= event.minimum">();
  });

  it("quantifies over the event itself when the payload is an array", () => {
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event any ( type == 'nodeCreated' )">
    >().toEqualTypeOf<"event any ( type == 'nodeCreated' )">();
    expectTypeOf<
      ValidateWebhookFilter<{ type: string }[], "event all ( type == 'nodeCreated' )">
    >().toEqualTypeOf<"event all ( type == 'nodeCreated' )">();
    expectTypeOf<
      ValidateWebhookFilter<{ type: string }, "event any ( type == 'nodeCreated' )">
    >().toMatchTypeOf<`✖ ${string}`>();
    webhook({
      id: "webhooks.test.tailscale-batch-filter",
      endpoint: webhooks.endpoint.define({ id: "tailscale-batch", source: webhooks.tailscale() }),
      filter: "event any ( type == 'nodeCreated' )",
      onEvent: async () => {},
    });
  });

  it("rejects malformed paths even when the event shape is unknown", () => {
    const malformedFilters = [
      "event == 1",
      "event. == 1",
      "event..amount >= 1",
      "event.amount. >= 1",
      "event.data.object..amount >= 1",
      "header. == 'x'",
      "header..name == 'x'",
      "event.amount >= event..limit",
      "event.amount >= webhook.",
      "event..items any ( amount >= 1 )",
      "event.items any ( amount. >= 1 )",
      "event.items any ( item..amount >= 1 )",
    ] as const;
    expectTypeOf<
      ValidateWebhookFilter<unknown, (typeof malformedFilters)[number]>
    >().toMatchTypeOf<`✖ ${string}`>();
    webhook({
      id: "webhooks.test.stripe-malformed-path",
      endpoint: webhooks.endpoint.define({
        id: "stripe-malformed-path",
        source: webhooks.stripe(),
      }),
      // @ts-expect-error the open record must still reject empty path segments
      filter: "event.data.object..amount >= 10000",
      onEvent: async () => {},
    });
  });

  it("still checks known fields and syntax below unknown payloads", () => {
    webhook({
      id: "webhooks.test.stripe-invalid-filter",
      endpoint: webhooks.endpoint.define({
        id: "stripe-invalid-filter",
        source: webhooks.stripe(),
      }),
      // @ts-expect-error Stripe's known type field is a string
      filter: "event.type >= 10000",
      onEvent: async () => {},
    });
    webhook({
      id: "webhooks.test.typed-invalid-filter",
      endpoint: webhooks.endpoint.define({
        id: "typed-invalid-filter",
        source: webhooks.stripe<{ amount: number }>(),
      }),
      // @ts-expect-error concrete event types still reject missing fields
      filter: "event.missing == 1",
      onEvent: async () => {},
    });
    expectTypeOf<
      ValidateWebhookFilter<{ amount: number }, "event.amount == 'wrong'">
    >().toEqualTypeOf<"✖ value 'wrong' is not valid for event.amount">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "webhook.missing == 'wrong'">
    >().toEqualTypeOf<"✖ unknown field: webhook.missing">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.amount >= 'wrong'">
    >().toEqualTypeOf<"✖ event.amount needs a number">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.name startsWith 100">
    >().toEqualTypeOf<"✖ event.name op needs a string literal">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.type bogus 'created'">
    >().toEqualTypeOf<"✖ unknown operator: bogus">();
    expectTypeOf<
      ValidateWebhookFilter<unknown, "event.type == unquoted">
    >().toEqualTypeOf<"✖ cannot parse value: unquoted">();
    expectTypeOf<
      ValidateWebhookFilter<{ amount: number }, "event.amount any ( value == 1 )">
    >().toEqualTypeOf<"✖ event.amount is not an array">();
  });

  it("accepts spaced lists and quoted strings that contain spaces", () => {
    type Event = { action: string; title: string; count: number };
    expectTypeOf<
      ValidateWebhookFilter<Event, "event.action in ['opened', 'closed']">
    >().toEqualTypeOf<"event.action in ['opened', 'closed']">();
    expectTypeOf<
      ValidateWebhookFilter<Event, "event.count not in [ 1, 2 ] && event.action == 'x'">
    >().toEqualTypeOf<"event.count not in [ 1, 2 ] && event.action == 'x'">();
    expectTypeOf<
      ValidateWebhookFilter<Event, "event.title startsWith 'Fix the build' || event.action == 'x'">
    >().toEqualTypeOf<"event.title startsWith 'Fix the build' || event.action == 'x'">();
    expectTypeOf<
      ValidateWebhookFilter<Event, "event.count in [1, 'two']">
    >().toEqualTypeOf<"✖ value 'two' is not valid for event.count">();
  });
});

describe("webhook endpoints and subscribers", () => {
  beforeAll(() => {
    resourceCatalog.setCurrentFileContext("src/trigger/payments.ts", "payments");
  });

  it("registers the endpoint with its source's setup prompt, and each subscriber against it", () => {
    {
      const payments = webhooks.endpoint.define({
        id: "payments-registered",
        source: webhooks.stripe<{ type: string; data: { object: { id: string } } }>(),
        metadata: { team: "billing" },
      });
      webhook({
        id: "orders-registered",
        endpoint: payments,
        filter: "event.type == 'checkout.session.completed'",
        onEvent: async () => {},
      });
      const orderEvents = chatEvent({
        id: "order-events-registered",
        endpoint: payments,
        key: "{event.data.object.id}",
        type: "order.event",
      });

      expect(payments).toEqual({ id: "payments-registered", source: "stripe" });
      const manifest = resourceCatalog.getWebhookEndpointManifest("payments-registered");
      expect(manifest).toMatchObject({
        id: "payments-registered",
        source: "stripe",
        secretProvisioning: "provider",
        metadata: { team: "billing" },
      });
      expect(manifest?.setupPrompt).toContain("stripe webhook_endpoints create");
      expect(
        resourceCatalog
          .listWebhookSubscribers()
          .filter((subscriber) => subscriber.endpointId === "payments-registered")
      ).toEqual([
        {
          endpointId: "payments-registered",
          target: {
            type: "task",
            id: "orders-registered",
            taskId: "orders-registered",
            filter: "event.type == 'checkout.session.completed'",
          },
        },
      ]);
      expect(orderEvents).toMatchObject({
        endpointId: "payments-registered",
        source: "stripe",
        key: "{body.data.object.id}",
        type: "order.event",
      });
    }
  });

  it("refuses an endpoint id starting with wh_, the prefix of generated endpoint ids", () => {
    expect(() => webhooks.endpoint.define({ id: "wh_orders", source: webhooks.stripe() })).toThrow(
      /can't start with "wh_"/
    );
  });

  it("attaches the provider's setup prompt to named providers and presets that have one", () => {
    webhooks.endpoint.define({ id: "shopify-prompt", source: webhooks.shopify() });
    webhooks.endpoint.define({ id: "discord-prompt", source: webhooks.discord() });
    webhooks.endpoint.define({ id: "calendly-prompt", source: webhooks.calendly() });

    const shopify = resourceCatalog.getWebhookEndpointManifest("shopify-prompt");
    expect(shopify?.secretProvisioning).toBe("provider");
    expect(shopify?.setupPrompt).toContain("webhookSubscriptionCreate");
    expect(resourceCatalog.getWebhookEndpointManifest("discord-prompt")?.setupPrompt).toContain(
      "Public Key"
    );
    expect(
      resourceCatalog.getWebhookEndpointManifest("calendly-prompt")?.setupPrompt
    ).toBeUndefined();
  });

  it("uses a custom source's own setup prompt", () => {
    {
      webhooks.endpoint.define({
        id: "internal-prompt",
        source: webhooks.custom(
          { scheme: "shared-secret", placement: "header", fieldName: "x-token" },
          { setupPrompt: "Add the URL in the internal admin under Integrations." }
        ),
      });
      expect(resourceCatalog.getWebhookEndpointManifest("internal-prompt")?.setupPrompt).toBe(
        "Add the URL in the internal admin under Integrations."
      );
    }
  });

  it("passes the endpoint a delivery arrived on to onEvent", async () => {
    const seen: unknown[] = [];
    const handle = webhook({
      id: "webhooks.test.endpoint-context",
      endpoint: webhooks.endpoint.define({ id: "endpoint-context", source: webhooks.stripe() }),
      onEvent: async ({ endpoint }) => {
        seen.push(endpoint);
      },
    });
    const endpoint = { id: "wh_1", declaredId: "endpoint-context", metadata: {} };
    await resourceCatalog
      .getTask(handle.id)!
      .fns.run({ event: { id: "evt_1" }, endpoint }, { ctx: {} as never } as never);
    expect(seen).toEqual([endpoint]);
  });

  it("refuses a subscriber without an endpoint", () => {
    expect(() =>
      webhook({ id: "webhooks.test.no-endpoint", onEvent: async () => {} } as never)
    ).toThrow(/an endpoint is required/);
  });
});

describe("webhook waiter match types", () => {
  it("accepts paths into open provider payloads, headers and endpoint fields", () => {
    const payments = webhooks.endpoint.define({ id: "waiter-types", source: webhooks.stripe() });
    const orders = webhooks.endpoint.define({
      id: "waiter-types-orders",
      source: webhooks.custom<{ type: string; order: { id: string; total: number } }>({
        scheme: "shared-secret",
        placement: "header",
        fieldName: "x-token",
      }),
    });

    const accept = () => {
      void webhooks.waiter.create(payments, {
        match: {
          "event.data.object.metadata.orderId": "ord_1",
          "event.type": "payment_intent.succeeded",
        },
      });
      void webhooks.waiter.create(orders, {
        match: { "event.order.id": "ord_1", "header.x-shop": "acme", "webhook.id": "orders" },
        filter: "event.order.total > 100",
      });
      void webhooks.waiter.create(orders, {
        // @ts-expect-error a match path needs a namespace
        match: { "order.id": "ord_1" },
      });
    };
    expect(typeof accept).toBe("function");
  });

  it("names the problem with each bad path", () => {
    type Order = { type: string; order: { id: string; total: number } };
    type Check<M> = ValidatedWebhookMatch<Order, M>;
    expectTypeOf<
      Check<{ "order.id": "x" }>["order.id"]
    >().toEqualTypeOf<"✖ match paths start with event., header. or webhook.: order.id">();
    expectTypeOf<
      Check<{ "body.order.id": "x" }>["body.order.id"]
    >().toEqualTypeOf<"✖ match paths start with event., header. or webhook.: body.order.id">();
    expectTypeOf<
      Check<{ "event.order.missing": "x" }>["event.order.missing"]
    >().toEqualTypeOf<"✖ unknown event path: order.missing">();
    expectTypeOf<
      Check<{ "event.order": "x" }>["event.order"]
    >().toEqualTypeOf<"✖ non-scalar event path: order">();
    expectTypeOf<
      Check<{ "event.order..id": "x" }>["event.order..id"]
    >().toEqualTypeOf<"✖ empty path segment: order..id">();
    expectTypeOf<
      Check<{ "webhook.nope": "x" }>["webhook.nope"]
    >().toEqualTypeOf<"✖ unknown or non-scalar webhook meta path: nope">();
    expectTypeOf<Check<{ "header.": "x" }>["header."]>().toEqualTypeOf<"✖ empty header name">();
    expectTypeOf<Check<{ "event.order.id": "x" }>["event.order.id"]>().toEqualTypeOf<"x">();
  });
});

describe("chat.event key types", () => {
  type Order = { type: string; order: { id: string; total: number; lines: string[] } };

  it("accepts event, header and webhook placeholders, fallbacks and open provider payloads", () => {
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.order.id}">
    >().toEqualTypeOf<"{event.order.id}">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{webhook.externalRef}-{header.x-shop}:{event.order.total}">
    >().toEqualTypeOf<"{webhook.externalRef}-{header.x-shop}:{event.order.total}">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.order.id || event.type}">
    >().toEqualTypeOf<"{event.order.id || event.type}">();
    expectTypeOf<
      ValidatedWebhookKey<StripeWebhookEvent, "{event.data.object.customer}">
    >().toEqualTypeOf<"{event.data.object.customer}">();
    expectTypeOf<
      ValidatedWebhookKey<unknown, "{event.anything.at.all}">
    >().toEqualTypeOf<"{event.anything.at.all}">();
  });

  it("rejects a missing namespace, a bad path and a non-scalar", () => {
    expectTypeOf<
      ValidatedWebhookKey<Order, "{order.id}">
    >().toEqualTypeOf<"✖ key paths start with event., header. or webhook.: order.id">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{body.order.id}">
    >().toEqualTypeOf<"✖ key paths start with event., header. or webhook.: body.order.id">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.order.missing}">
    >().toEqualTypeOf<"✖ unknown event path: order.missing">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.order}">
    >().toEqualTypeOf<"✖ non-scalar event path: order">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.order.lines}">
    >().toEqualTypeOf<"✖ non-scalar event path: order.lines">();
    expectTypeOf<
      ValidatedWebhookKey<unknown, "{event.}">
    >().toEqualTypeOf<"✖ empty path segment: ">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{event.type || order.id}">
    >().toEqualTypeOf<"✖ key paths start with event., header. or webhook.: order.id">();
    expectTypeOf<
      ValidatedWebhookKey<Order, "{webhook.nope}">
    >().toEqualTypeOf<"✖ unknown or non-scalar webhook meta path: nope">();
    expectTypeOf<ValidatedWebhookKey<Order, "{header.}">>().toEqualTypeOf<"✖ empty header name">();
  });

  it("stores the key against the body and rejects an unnamespaced key at define time", () => {
    const orders = webhooks.endpoint.define({ id: "key-types", source: webhooks.stripe<Order>() });
    expect(
      chatEvent({ id: "key-types-event", endpoint: orders, key: "{event.order.id}" }).key
    ).toBe("{body.order.id}");
    expect(() =>
      chatEvent({
        id: "key-types-bare",
        endpoint: orders,
        // @ts-expect-error a key path needs a namespace
        key: "{order.id}",
      })
    ).toThrow("Use {event.order.id}");
  });
});
