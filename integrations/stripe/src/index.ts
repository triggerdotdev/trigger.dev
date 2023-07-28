import { Stripe as StripeClient } from "stripe";
import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  type HandlerEvent,
  type IntegrationClient,
  type Logger,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import type {
  StripeSDK,
  StripeIntegrationOptions,
  WebhookEvents,
} from "./types";

import * as tasks from "./tasks";
import z from "zod";
import * as events from "./events";

export * from "./types";

type StripeIntegrationClient = IntegrationClient<StripeSDK, typeof tasks>;
type StripeIntegration = TriggerIntegration<StripeIntegrationClient>;

export class Stripe implements StripeIntegration {
  client: StripeIntegrationClient;

  /**
   * The native Stripe client. This is exposed for use outside of Trigger.dev jobs
   *
   * @example
   * ```ts
   * import { Stripe } from "@trigger.dev/stripe";
   *
   * const stripe = new Stripe({
   *  id: "stripe",
   *  apiKey: process.env.STRIPE_API_KEY!,
   * });
   *
   * const customer = await stripe.native.customers.create({}); // etc.
   * ```
   */
  public readonly native: StripeClient;

  constructor(private options: StripeIntegrationOptions) {
    this.native = new StripeClient(options.apiKey, {
      apiVersion: "2022-11-15",
      typescript: true,
      timeout: 10000,
      maxNetworkRetries: 0,
      stripeAccount: options.stripeAccount,
      appInfo: {
        name: "Trigger.dev Stripe Integration",
        version: "0.1.0",
        url: "https://trigger.dev",
      },
    });

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: this.native,
      auth: {
        apiKey: options.apiKey,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "stripe", name: "Stripe" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  /**
   * Occurs whenever a price is created.
   */
  onPriceCreated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPriceCreated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a price is updated.
   */
  onPriceUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPriceUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a price is deleted.
   */
  onPriceDeleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPriceDeleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a product is created.
   */
  onProductCreated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onProductCreated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a product is updated.
   */
  onProductUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onProductUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a product is deleted.
   */
  onProductDeleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onProductDeleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a Checkout Session has been successfully completed.
   */
  onCheckoutSessionCompleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCheckoutSessionCompleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a Checkout Session is expired.
   */
  onCheckoutSessionExpired(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCheckoutSessionExpired,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer is signed up for a new plan.
   */
  onCustomerSubscriptionCreated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionCreated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription is paused. Only applies when subscriptions enter `status=paused`, not when [payment collection](https://stripe.com/docs/billing/subscriptions/pause) is paused.
   */
  onCustomerSubscriptionPaused(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionPaused,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription is no longer paused. Only applies when a `status=paused` subscription is [resumed](https://stripe.com/docs/api/subscriptions/resume), not when [payment collection](https://stripe.com/docs/billing/subscriptions/pause) is resumed.
   */
  onCustomerSubscriptionResumed(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionResumed,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a subscription changes (e.g., switching from one plan to another, or changing the status from trial to active).
   */
  onCustomerSubscriptionUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription ends.
   */
  onCustomerSubscriptionDeleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionDeleted,
      params ?? { connect: false }
    );
  }
}

export type TriggerParams = {
  connect?: boolean;
  filter?: EventFilter;
};

type StripeEvents = (typeof events)[keyof typeof events];

type CreateTriggersResult<TEventSpecification extends StripeEvents> =
  ExternalSourceTrigger<
    TEventSpecification,
    ReturnType<typeof createWebhookEventSource>
  >;

function createTrigger<TEventSpecification extends StripeEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams
): CreateTriggersResult<TEventSpecification> {
  return new ExternalSourceTrigger({
    event,
    params,
    source,
  });
}

const WebhookDataSchema = z.object({
  id: z.string(),
  object: z.literal("webhook_endpoint"),
  api_version: z.string().nullable(),
  application: z.string().nullable(),
  created: z.number(),
  description: z.string().nullable(),
  enabled_events: z.array(z.string()),
  livemode: z.boolean(),
  metadata: z.record(z.string()),
  status: z.enum(["enabled", "disabled"]),
  url: z.string(),
});

function createWebhookEventSource(
  integration: StripeIntegration
): ExternalSource<StripeIntegration, { connect?: boolean }, "HTTP"> {
  return new ExternalSource("HTTP", {
    id: "stripe.webhook",
    schema: z.object({ connect: z.boolean().optional() }),
    version: "0.1.0",
    integration,
    key: (params) => `stripe.webhook${params.connect ? ".connect" : ""}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      const webhookData = WebhookDataSchema.safeParse(httpSource.data);

      const allEvents = Array.from(new Set([...events, ...missingEvents]));

      if (httpSource.active && webhookData.success) {
        if (missingEvents.length === 0) return;

        const updatedWebhook = await io.integration.updateWebhook(
          "update-webhook",
          {
            id: webhookData.data.id,
            url: httpSource.url,
            enabled_events: allEvents as unknown as WebhookEvents[],
          }
        );

        return {
          data: WebhookDataSchema.parse(updatedWebhook),
          registeredEvents: allEvents,
        };
      }

      const listResponse = await io.integration.listWebhooks("list-webhooks", {
        limit: 100,
      });

      const existingWebhook = listResponse.data.find(
        (w) => w.url === httpSource.url
      );

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook(
          "update-found-webhook",
          {
            id: existingWebhook.id,
            url: httpSource.url,
            enabled_events: allEvents as unknown as WebhookEvents[],
            disabled: false,
          }
        );

        return {
          data: WebhookDataSchema.parse(updatedWebhook),
          registeredEvents: allEvents,
        };
      }

      const webhook = await io.integration.createWebhook("create-webhook", {
        url: httpSource.url,
        enabled_events: allEvents as unknown as WebhookEvents[],
        connect: params.connect,
      });

      return {
        data: WebhookDataSchema.parse(webhook),
        secret: webhook.secret,
        registeredEvents: allEvents,
      };
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[@trigger.dev/stripe] Handling webhook payload");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[@trigger.dev/stripe] No body found");

    return { events: [] };
  }

  const rawBody = await request.text();

  const signature = request.headers.get("stripe-signature");

  if (signature) {
    const stripeClient = new StripeClient("", { apiVersion: "2022-11-15" });

    try {
      const event = stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        source.secret
      );

      return {
        events: [
          {
            id: event.id,
            payload: event.data.object,
            source: "stripe.com",
            name: event.type,
            timestamp: new Date(event.created * 1000),
            context: {
              apiVersion: event.api_version,
              livemode: event.livemode,
              request: event.request,
              previousAttributes: event.data.previous_attributes,
            },
          },
        ],
      };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(
          "[@trigger.dev/stripe] Error while validating webhook signature",
          {
            error: { name: error.name, message: error.message },
          }
        );
      } else {
        logger.error(
          "[@trigger.dev/stripe] Unknown Error while validating webhook signature"
        );
      }

      return { events: [] };
    }
  }

  return {
    events: [],
  };
}
