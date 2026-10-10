import {
  BoltIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ClockIcon,
  CodeBracketIcon,
  PauseCircleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { type ComponentType, type ReactNode } from "react";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { BetaBadge } from "~/components/FeatureBadges";
import { PageBody } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { type EndpointsListRow } from "~/components/webhookEndpoints/v1/EndpointsListTable";
import { WebhooksBetaPreview } from "~/components/webhookEndpoints/WebhooksBetaPreview";
import type { EndpointActivity } from "~/presenters/v3/WebhookEndpointsListPresenter.server";

const taskExample = `import { webhook, webhooks } from "@trigger.dev/sdk";

export const stripe = webhooks.endpoint.define({
  id: "stripe",
  source: webhooks.stripe(),
});

export const fulfillOrder = webhook({
  id: "fulfill-order",
  endpoint: stripe,
  filter: "event.type == 'checkout.session.completed'",
  onEvent: async ({ event }) => {
    await fulfill(event.data.object.id);
  },
});`;

const agentExample = `import { webhooks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { slack, webhookSource } from "@trigger.dev/slack";

const slackEvents = webhooks.endpoint.define({
  id: "slack",
  source: webhookSource(),
});

export const support = chat.agent({
  id: "support",
  channels: [
    slack({
      id: "slack",
      endpoint: slackEvents,
      token: process.env.SLACK_BOT_TOKEN!,
    }),
  ],
  run: async ({ messages, signal, streamText }) =>
    streamText({ model, messages, abortSignal: signal }),
});`;

export function WebhooksBetaAccess({
  requested,
  previewEndpoints,
  previewActivity,
}: {
  requested: boolean;
  previewEndpoints: EndpointsListRow[];
  previewActivity: Promise<EndpointActivity>;
}) {
  const fetcher = useFetcher<{ requested: boolean }>();
  const isRequested = requested || fetcher.data?.requested === true;

  return (
    <>
      <NavBar>
        <PageTitle title="Webhooks" accessory={<BetaBadge />} />
      </NavBar>
      <PageBody>
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-2 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-grid-bright bg-background-bright py-3 pl-4 pr-3">
            <Paragraph variant="base/bright">
              {isRequested
                ? "Webhooks are in private beta. You're on the wait list for this organization."
                : "Webhooks are in private beta. Request access and we'll turn them on for your organization."}
            </Paragraph>
            <fetcher.Form method="post">
              {isRequested ? (
                <Button
                  type="button"
                  variant="secondary/medium"
                  LeadingIcon={CheckIcon}
                  leadingIconClassName="text-success"
                  disabled
                >
                  Access requested
                </Button>
              ) : (
                <Button type="submit" variant="primary/medium" disabled={fetcher.state !== "idle"}>
                  Request beta access
                </Button>
              )}
            </fetcher.Form>
          </div>

          <WebhooksBetaPreview endpoints={previewEndpoints} activity={previewActivity} />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <FeatureGrid>
              <Feature icon={ShieldCheckIcon} title="Signature verification">
                Built-in sources for Stripe, GitHub, Slack, Linear and dozens more, or any HMAC
                scheme. Bad signatures are rejected before a run starts.
              </Feature>
              <Feature icon={ClockIcon} title="Delivery history and replay">
                Every delivery is stored with its headers and body. Replay any of them from the
                dashboard or the API.
              </Feature>
              <Feature icon={CodeBracketIcon} title="Typesafe filters">
                Filters are type checked against the provider's events, and only matching deliveries
                start a run.
              </Feature>
              <Feature icon={WebhookIcon} title="No server to run">
                Each endpoint gets its own URL hosted by Trigger.dev, so there's nothing for you to
                deploy or keep running.
              </Feature>
            </FeatureGrid>
            <CodeBlock code={taskExample} language="typescript" fileName="trigger/orders.ts" />
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <CodeBlock code={agentExample} language="typescript" fileName="trigger/support.ts" />
            <FeatureGrid>
              <Feature icon={ChatBubbleLeftRightIcon} title="Events become messages">
                Route webhook events into a <code>chat.agent</code> conversation, so the agent
                replies with full context.
              </Feature>
              <Feature icon={PauseCircleIcon} title="Wait for a webhook">
                Pause a task until a matching webhook arrives, like a payment succeeding, then carry
                on from where it left off.
              </Feature>
              <Feature icon={BoltIcon} title="Fast acknowledgement">
                The endpoint responds right away, inside Slack's 3 second limit. The agent runs
                after that.
              </Feature>
              <Feature icon={ShieldCheckIcon} title="Slack built in">
                <code>@trigger.dev/slack</code> verifies Slack's signing secret for you, with no
                handler code.
              </Feature>
            </FeatureGrid>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function FeatureGrid({ children }: { children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 overflow-hidden rounded-md border border-grid-bright bg-background-bright sm:grid-cols-2 [&>*]:border-grid-bright max-sm:[&>*:not(:last-child)]:border-b sm:[&>*:nth-child(-n+2)]:border-b sm:[&>*:nth-child(odd)]:border-r">
      {children}
    </section>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="grid size-7 place-items-center rounded border border-grid-bright bg-background-raised">
        <Icon className="size-4 text-webhooks" />
      </div>
      <Header3 className="mt-1">{title}</Header3>
      <Paragraph
        variant="small"
        className="[&_code]:font-mono [&_code]:text-xs [&_code]:text-text-bright"
      >
        {children}
      </Paragraph>
    </div>
  );
}
