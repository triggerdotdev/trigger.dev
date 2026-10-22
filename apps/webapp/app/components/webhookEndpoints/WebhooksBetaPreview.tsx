import { ArrowRightIcon, EyeIcon } from "@heroicons/react/20/solid";
import type { WebhookDeliveryStatus } from "@trigger.dev/database";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { DeliveryStatusBadge } from "~/components/webhookDeliveries/v1/DeliveryStatus";
import {
  type EndpointsListRow,
  EndpointsListTable,
} from "~/components/webhookEndpoints/v1/EndpointsListTable";
import type { EndpointActivity } from "~/presenters/v3/WebhookEndpointsListPresenter.server";

type SampleDelivery = {
  source: string;
  event: string;
  task?: string;
  status: WebhookDeliveryStatus;
};

const SAMPLE_DELIVERIES: SampleDelivery[] = [
  {
    source: "stripe",
    event: "checkout.session.completed",
    task: "fulfill-order",
    status: "SUCCEEDED",
  },
  { source: "slack", event: "app_mention", task: "support", status: "SUCCEEDED" },
  { source: "github", event: "pull_request.opened", task: "review-pr", status: "SUCCEEDED" },
  { source: "stripe", event: "invoice.paid", status: "FILTERED" },
  { source: "linear", event: "Issue.create", task: "triage", status: "SUCCEEDED" },
  { source: "shopify", event: "orders/create", task: "sync-order", status: "PROCESSING" },
  { source: "github", event: "push", status: "FILTERED" },
  { source: "clerk", event: "user.created", task: "onboard-user", status: "SUCCEEDED" },
];

const VISIBLE_DELIVERIES = 3;
const DELIVERY_INTERVAL_MS = 2200;

export function WebhooksBetaPreview({
  endpoints,
  activity,
}: {
  endpoints: EndpointsListRow[];
  activity: Promise<EndpointActivity>;
}) {
  return (
    <section
      aria-label="Preview of the Webhooks page with sample data"
      className="relative h-[22rem] overflow-hidden rounded-md border border-grid-bright bg-background-bright"
    >
      <div
        aria-hidden
        {...{ inert: "" }}
        className="pointer-events-none select-none opacity-70 saturate-[0.8]"
      >
        <EndpointsListTable endpoints={endpoints} activity={activity} hasFilters={false} />
      </div>

      <div className="pointer-events-none absolute inset-0 backdrop-blur-[1px] [mask-image:linear-gradient(to_bottom,transparent_15%,black_40%)]" />
      <div className="pointer-events-none absolute inset-0 backdrop-blur-[3px] [mask-image:linear-gradient(to_bottom,transparent_40%,black_65%)]" />
      <div className="pointer-events-none absolute inset-0 backdrop-blur-[8px] [mask-image:linear-gradient(to_bottom,transparent_60%,black_85%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-40% to-background-bright" />

      <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-grid-bright bg-background-raised px-2.5 py-1 text-xs text-text-dimmed">
        <EyeIcon className="size-3.5" />
        Preview with sample data
      </span>

      <DeliveryFeed />
    </section>
  );
}

function DeliveryFeed() {
  const reduceMotion = useReducedMotion();
  const [count, setCount] = useState(VISIBLE_DELIVERIES);

  useEffect(() => {
    if (reduceMotion) return;
    const interval = setInterval(() => setCount((current) => current + 1), DELIVERY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reduceMotion]);

  const visible = Array.from({ length: VISIBLE_DELIVERIES }, (_, offset) => count - 1 - offset);

  return (
    <div aria-hidden className="absolute inset-x-0 bottom-12 flex flex-col items-center gap-2 px-4">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((index, position) => (
          <motion.div
            key={index}
            layout
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1 - position * 0.3, y: 0, scale: 1 - position * 0.03 }}
            exit={{ opacity: 0, y: 12, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="w-full max-w-xl"
          >
            <DeliveryCard
              delivery={SAMPLE_DELIVERIES[index % SAMPLE_DELIVERIES.length]}
              isNewest={position === 0}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function DeliveryCard({ delivery, isNewest }: { delivery: SampleDelivery; isNewest: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-grid-bright bg-background-raised/95 px-3 py-2 text-sm shadow-lg">
      <span className="rounded border border-grid-bright px-1.5 py-0.5 font-mono text-xs text-text-bright">
        {delivery.source}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-dimmed">
        {delivery.event}
      </span>
      {delivery.task ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-bright">
          <ArrowRightIcon className="size-3.5 text-text-dimmed" />
          <span className="font-mono">{delivery.task}</span>
        </span>
      ) : null}
      <DeliveryStatusBadge status={delivery.status} className="w-24 shrink-0 text-xs" />
      <span className="w-8 shrink-0 text-right text-xs text-text-dimmed">
        {isNewest ? "now" : ""}
      </span>
    </div>
  );
}
