---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"trigger.dev": minor
---

Add hosted webhooks: declare an endpoint once with `webhooks.endpoint.define({ id, source })` and Trigger.dev hosts its URL, verifies every request, and routes each event to the endpoint's subscribers. Subscribe tasks with `webhook({ endpoint, filter, onEvent })`, each with its own type-safe filter, and pause a run until a matching webhook arrives with `webhooks.waiter.create()` and `webhooks.waiter.wait()`.

```ts
export const stripe = webhooks.endpoint.define({ id: "stripe", source: webhooks.stripe() });

export const fulfill = webhook({
  id: "fulfill",
  endpoint: stripe,
  filter: "event.type == 'checkout.session.completed'",
  onEvent: async ({ event }) => {},
});

const waiter = await webhooks.waiter.create(stripe, {
  match: { "event.data.object.metadata.orderId": order.id },
});
const { event } = await webhooks.waiter.wait(waiter).unwrap();
```

Sources cover presets (`webhooks.stripe()`, `webhooks.github()`, `webhooks.svix()`, `webhooks.discord()`, and others), named providers (`webhooks.clerk()`, `webhooks.shopify()`, and more) and `webhooks.custom<T>(config)`, and most carry a setup prompt an AI coding agent can follow to register the endpoint. Retries are deduplicated on the provider's own event or delivery id where it sends one. Filters, keys and waiter `match` paths share the `event.`, `header.` and `webhook.` namespaces, and filters accept `== null` / `!= null` presence checks and `event any (...)` over a payload that is an array of events. `webhook()` takes `task()` options such as `queue`, `machine` and `retry`. The HTTP API lists endpoints and deliveries, replays deliveries, and creates and cancels waiters, and both it and the MCP server can read an endpoint's setup prompt and generate or store its signing secret.
