# Trigger.dev Events (v4)

**Pub/sub event system for fan-out, event-driven workflows, and task coordination**

## Defining Events

```ts
import { event } from "@trigger.dev/sdk";
import { z } from "zod";

// Event with typed schema
export const orderCreated = event({
  id: "order.created",
  schema: z.object({
    orderId: z.string(),
    amount: z.number(),
    customerId: z.string(),
  }),
});

// Event without schema (payload is `unknown`)
export const systemAlert = event({
  id: "system.alert",
  description: "Generic system alert",
});

// Event with rate limiting
export const userActivity = event({
  id: "user.activity",
  schema: z.object({ userId: z.string(), action: z.string() }),
  rateLimit: {
    limit: 500,
    window: "1m", // "10s", "1m", "1h"
  },
});
```

> Events MUST be exported from your task files. The schema supports Zod, Valibot, ArkType, and any schema library compatible with `@standard-schema`.

## Subscribing Tasks to Events

```ts
import { task } from "@trigger.dev/sdk";
import { orderCreated } from "./events";

// Subscribe a task to an event — payload is typed from schema
export const sendOrderEmail = task({
  id: "send-order-email",
  on: orderCreated,
  run: async (payload) => {
    // payload is typed: { orderId: string, amount: number, customerId: string }
    await sendEmail(payload.customerId, `Order ${payload.orderId} confirmed!`);
  },
});

// Multiple tasks can subscribe to the same event (fan-out)
export const updateInventory = task({
  id: "update-inventory",
  on: orderCreated,
  run: async (payload) => {
    await adjustStock(payload.orderId);
  },
});
```

## Publishing Events

```ts
import { orderCreated } from "./events";

// From inside a task
export const checkoutTask = task({
  id: "checkout",
  run: async (payload: { orderId: string; amount: number; customerId: string }) => {
    // Process checkout...

    // Publish event — triggers all subscribed tasks
    const result = await orderCreated.publish({
      orderId: payload.orderId,
      amount: payload.amount,
      customerId: payload.customerId,
    });

    console.log(`Published ${result.id}, triggered ${result.runs.length} tasks`);
  },
});
```

### Publish Options

```ts
await orderCreated.publish(payload, {
  idempotencyKey: `order-${orderId}`,  // Prevent duplicate publishes
  delay: "30s",                         // Delay before triggering subscribers
  tags: ["priority", "vip"],            // Tags on generated runs
  metadata: { source: "checkout" },     // Metadata on generated runs
  orderingKey: customerId,              // Sequential processing per key
});
```

### Batch Publish

```ts
const results = await orderCreated.batchPublish([
  { payload: { orderId: "1", amount: 50, customerId: "a" } },
  { payload: { orderId: "2", amount: 100, customerId: "b" }, options: { tags: ["bulk"] } },
]);
```

## Content-based Filtering

Subscribe only to events that match a filter:

```ts
export const highValueHandler = task({
  id: "high-value-order",
  on: orderCreated,
  filter: {
    amount: [{ $gte: 1000 }],
  },
  run: async (payload) => {
    // Only receives orders with amount >= 1000
    await notifyVipTeam(payload);
  },
});
```

## Wildcard Pattern Subscriptions

Subscribe to multiple event types using wildcard patterns:

```ts
import { events, task } from "@trigger.dev/sdk";

// * matches exactly one segment
export const orderHandler = task({
  id: "order-handler",
  on: events.match("order.*"), // matches order.created, order.updated, etc.
  run: async (payload) => {
    // payload is `unknown` for pattern subscriptions
  },
});

// # matches zero or more segments
export const allHandler = task({
  id: "audit-logger",
  on: events.match("order.#"), // matches order, order.created, order.status.changed
  run: async (payload) => {
    await logAuditEvent(payload);
  },
});
```

## Publish and Wait (Fan-out / Fan-in)

Publish an event and wait for all subscriber tasks to complete:

```ts
export const orchestrator = task({
  id: "orchestrator",
  run: async (payload) => {
    const result = await orderCreated.publishAndWait({
      orderId: "123",
      amount: 500,
      customerId: "abc",
    });

    // result.results is Record<taskSlug, TaskRunExecutionResult>
    for (const [taskSlug, runResult] of Object.entries(result.results)) {
      console.log(`${taskSlug}: ${runResult.ok ? "success" : "failed"}`);
    }
  },
});
```

> `publishAndWait` can only be called from inside a `task.run()`. It blocks until all subscribers finish.

## Ordering Keys

Ensure events with the same key are processed sequentially per consumer:

```ts
await orderCreated.publish(payload, {
  orderingKey: payload.customerId, // All events for same customer processed in order
});
```

## Consumer Groups

Within a consumer group, only one task receives each event (load balancing):

```ts
export const workerA = task({
  id: "order-processor-a",
  on: orderCreated,
  consumerGroup: "order-processors",
  run: async (payload) => { /* ... */ },
});

export const workerB = task({
  id: "order-processor-b",
  on: orderCreated,
  consumerGroup: "order-processors",
  run: async (payload) => { /* ... */ },
});

// Each published event goes to either workerA OR workerB, not both
```

## Validation

Pre-validate a payload before publishing:

```ts
try {
  const validated = await orderCreated.validate({ orderId: "123", amount: -1 });
} catch (error) {
  console.error("Invalid payload:", error);
}
```

## Dead Letter Queue

Events that fail after all retries are captured in a DLQ. The DLQ is managed via API:

- `GET /api/v1/events/dlq` — list failed events
- `POST /api/v1/events/dlq/:id/retry` — retry a failed event
- `POST /api/v1/events/dlq/:id/discard` — discard a failed event
- `POST /api/v1/events/dlq/retry-all` — retry all pending failures

## Event History & Replay

Published events are persisted and can be replayed:

- `GET /api/v1/events/:eventId/history` — view event history
- `POST /api/v1/events/:eventId/replay` — replay events in a date range

## Best Practices

- **Schema everything**: Define schemas for type safety and validation at publish time
- **Idempotency keys**: Use for critical events to prevent duplicate processing
- **Ordering keys**: Use when event order matters per entity (e.g., per customer)
- **Consumer groups**: Use when you want load balancing instead of fan-out
- **Filters**: Use to reduce unnecessary task invocations
- **Rate limits**: Configure per-event to protect downstream systems
- **publishAndWait**: Use for orchestration patterns (saga, scatter-gather)
- **DLQ**: Monitor and retry failed events, don't let them accumulate
