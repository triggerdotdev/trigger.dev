import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { ActiveSubscription, Plan, Plans, SetPlanBodySchema } from "@trigger.dev/platform/v2";
import { useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { cn } from "~/utils/cn";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { DefinitionTip } from "../../DefinitionTooltip";
import { Feedback } from "../../Feedback";
import { Button, LinkButton } from "../../primitives/Buttons";
import SegmentedControl from "../../primitives/SegmentedControl";
import { RunsVolumeDiscountTable } from "./RunsVolumeDiscountTable";
import { Spinner } from "../../primitives/Spinner";

const pricingDefinitions = {
  concurrentRuns: {
    title: "Concurrent runs",
    content: "The number of runs that can be executed at the same time.",
  },
  jobRuns: {
    title: "Job runs",
    content: "A single execution of a job.",
  },
  jobs: {
    title: "Jobs",
    content: "A durable function that can be executed on a schedule or in response to an event.",
  },
  tasks: {
    title: "Tasks",
    content: "The individual building blocks of a job run.",
  },
  events: {
    title: "Events",
    content: "Events trigger jobs to start running.",
  },
  integrations: {
    title: "Integrations",
    content: "Easily subscribe to webhooks and perform actions using APIs.",
  },
};

export function PricingTiers({
  organizationSlug,
  plans,
  className,
  showActionText = true,
  freeButtonPath,
}: {
  organizationSlug: string;
  plans: Plans;
  className?: string;
  showActionText?: boolean;
  freeButtonPath?: string;
}) {
  const currentPlan = useCurrentPlan();
  //if they've canceled, we set the subscription to undefined so they can re-upgrade
  let currentSubscription = currentPlan?.subscription;
  if (currentPlan?.subscription?.canceledAt) {
    currentSubscription = undefined;
  }

  return (
    <div
      className={cn(
        "flex min-w-full flex-col items-start justify-center gap-4 md:flex-row",
        className
      )}
    >
      <TierFree
        plan={plans.free}
        currentSubscription={currentSubscription}
        organizationSlug={organizationSlug}
        showActionText={showActionText}
        buttonPath={freeButtonPath}
      />
      <TierPro
        plan={plans.paid}
        currentSubscription={currentSubscription}
        organizationSlug={organizationSlug}
        showActionText={showActionText}
      />
      <TierEnterprise />
    </div>
  );
}

export function TierFree({
  plan,
  organizationSlug,
  showActionText,
  currentSubscription,
  buttonPath,
}: {
  plan: Plan;
  organizationSlug: string;
  showActionText: boolean;
  currentSubscription?: ActiveSubscription;
  buttonPath?: string;
}) {
  const lastSubmission = useActionData();
  const [form] = useForm({
    id: "subscribe",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: SetPlanBodySchema });
    },
  });

  const navigation = useNavigation();
  const isLoading =
    (navigation.state === "submitting" || navigation.state === "loading") &&
    navigation.formData?.get("type") === "free";

  const isCurrentPlan =
    currentSubscription?.isPaying === undefined || currentSubscription?.isPaying === false;

  let actionText = "Select plan";

  if (showActionText) {
    if (isCurrentPlan) {
      actionText = "Current Plan";
    } else {
      actionText = "Downgrade";
    }
  }

  return (
    <TierContainer>
      <Form action={`/resources/${organizationSlug}/subscribe`} method="post" {...form.props}>
        <Header title={plan.title} cost={0} />
        <TierLimit>
          Up to {plan.concurrentRuns?.freeAllowance}{" "}
          <DefinitionTip
            title={pricingDefinitions.concurrentRuns.title}
            content={pricingDefinitions.concurrentRuns.content}
          >
            {pricingDefinitions.concurrentRuns.title}
          </DefinitionTip>
        </TierLimit>
        <input type="hidden" name="type" value="free" />
        <div className="py-6">
          {buttonPath ? (
            <LinkButton
              variant="tertiary/large"
              fullWidth
              className="text-md font-medium"
              to={buttonPath}
            >
              {actionText}
            </LinkButton>
          ) : (
            <Button
              variant="tertiary/large"
              fullWidth
              className="text-md font-medium"
              disabled={isLoading || isCurrentPlan}
            >
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <Spinner color="white" />
                  Updating plan
                </div>
              ) : (
                actionText
              )}
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-2.5">
          <FeatureItem checked>
            Up to {plan.runs?.freeAllowance ? formatNumberCompact(plan.runs.freeAllowance) : ""}{" "}
            <DefinitionTip
              title={pricingDefinitions.jobRuns.title}
              content={pricingDefinitions.jobRuns.content}
            >
              {pricingDefinitions.jobRuns.title}
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.jobs.title}
              content={pricingDefinitions.jobs.content}
            >
              jobs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.tasks.title}
              content={pricingDefinitions.tasks.content}
            >
              tasks
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.events.title}
              content={pricingDefinitions.events.content}
            >
              events
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>Unlimited team members</FeatureItem>
          <FeatureItem checked>24 hour log retention</FeatureItem>
          <FeatureItem checked>Community support</FeatureItem>
          <FeatureItem>Custom integrations</FeatureItem>
          <FeatureItem>Role-based access control</FeatureItem>
          <FeatureItem>SSO</FeatureItem>
          <FeatureItem>On-prem option</FeatureItem>
        </ul>
      </Form>
    </TierContainer>
  );
}

export function TierPro({
  plan,
  organizationSlug,
  showActionText,
  currentSubscription,
}: {
  plan: Plan;
  organizationSlug: string;
  showActionText: boolean;
  currentSubscription?: ActiveSubscription;
}) {
  const lastSubmission = useActionData();
  const [form] = useForm({
    id: "subscribe",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: SetPlanBodySchema });
    },
  });

  const navigation = useNavigation();
  const isLoading =
    (navigation.state === "submitting" || navigation.state === "loading") &&
    navigation.formData?.get("planCode") === plan.code;

  const currentConcurrencyTier = currentSubscription?.plan.concurrentRuns.pricing?.code;
  const [concurrentBracketCode, setConcurrentBracketCode] = useState(
    currentConcurrencyTier ?? plan.concurrentRuns?.pricing?.tiers[0].code
  );

  const concurrencyTiers = plan.concurrentRuns?.pricing?.tiers ?? [];
  const selectedTier = concurrencyTiers.find((c) => c.code === concurrentBracketCode);

  const freeRunCount = plan.runs?.pricing?.brackets[0].upto ?? 0;
  const mostExpensiveRunCost = plan.runs?.pricing?.brackets[1]?.unitCost ?? 0;

  const isCurrentPlan = currentConcurrencyTier === concurrentBracketCode;

  let actionText = "Select plan";

  if (showActionText) {
    if (isCurrentPlan) {
      actionText = "Current Plan";
    } else {
      const currentTierIndex = concurrencyTiers.findIndex((c) => c.code === currentConcurrencyTier);
      const selectedTierIndex = concurrencyTiers.findIndex((c) => c.code === concurrentBracketCode);
      actionText = currentTierIndex < selectedTierIndex ? "Upgrade" : "Downgrade";
    }
  }

  return (
    <TierContainer isHighlighted>
      <Form action={`/resources/${organizationSlug}/subscribe`} method="post" {...form.props}>
        <Header title={plan.title} isHighlighted cost={selectedTier?.tierCost} />

        <div className="mb-2 mt-6 font-sans text-sm font-normal text-text-bright">
          <DefinitionTip
            title={pricingDefinitions.concurrentRuns.title}
            content={pricingDefinitions.concurrentRuns.content}
          >
            {pricingDefinitions.concurrentRuns.title}
          </DefinitionTip>
        </div>
        <input type="hidden" name="type" value="paid" />
        <input type="hidden" name="planCode" value={plan.code} />
        <SegmentedControl
          name="concurrentRunBracket"
          options={concurrencyTiers.map((c) => ({ label: `Up to ${c.upto}`, value: c.code }))}
          fullWidth
          value={concurrentBracketCode}
          variant="primary"
          onChange={(v) => setConcurrentBracketCode(v)}
        />
        <div className="py-6">
          <Button
            variant="primary/large"
            fullWidth
            className="text-md font-medium"
            type="submit"
            disabled={isLoading || isCurrentPlan}
          >
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Spinner color="white" />
                Updating plan
              </div>
            ) : (
              actionText
            )}
          </Button>
        </div>
        <ul className="flex flex-col gap-2.5">
          <FeatureItem checked>
            Includes {freeRunCount ? formatNumberCompact(freeRunCount) : ""}{" "}
            <DefinitionTip
              title={pricingDefinitions.jobRuns.title}
              content={pricingDefinitions.jobRuns.content}
            >
              {pricingDefinitions.jobRuns.title}
            </DefinitionTip>
            , then{" "}
            <DefinitionTip
              title="Runs volume discount"
              content={
                <RunsVolumeDiscountTable hideHeader brackets={plan.runs?.pricing?.brackets ?? []} />
              }
            >
              {"<"} ${(mostExpensiveRunCost * 1000).toFixed(2)}/1K runs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.jobs.title}
              content={pricingDefinitions.jobs.content}
            >
              jobs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.tasks.title}
              content={pricingDefinitions.tasks.content}
            >
              tasks
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.events.title}
              content={pricingDefinitions.events.content}
            >
              events
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>Unlimited team members</FeatureItem>
          <FeatureItem checked>7 day log retention</FeatureItem>
          <FeatureItem checked>Dedicated Slack support</FeatureItem>
          <FeatureItem>Custom integrations</FeatureItem>
          <FeatureItem>Role-based access control</FeatureItem>
          <FeatureItem>SSO</FeatureItem>
          <FeatureItem>On-prem option</FeatureItem>
        </ul>
      </Form>
    </TierContainer>
  );
}

export function TierEnterprise() {
  return (
    <TierContainer>
      <Header title="Enterprise" />
      <TierLimit>
        Flexible{" "}
        <DefinitionTip
          title={pricingDefinitions.concurrentRuns.title}
          content={pricingDefinitions.concurrentRuns.content}
        >
          {pricingDefinitions.concurrentRuns.title}
        </DefinitionTip>
      </TierLimit>
      <div className="py-6">
        <Feedback
          button={
            <Button variant="secondary/large" fullWidth className="text-md font-medium">
              Contact us
            </Button>
          }
          defaultValue="enterprise"
        />
      </div>
      <ul className="flex flex-col gap-2.5">
        <FeatureItem checked>
          Flexible{" "}
          <DefinitionTip
            title={pricingDefinitions.jobRuns.title}
            content={pricingDefinitions.jobRuns.content}
          >
            {pricingDefinitions.jobRuns.title}
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.jobs.title}
            content={pricingDefinitions.jobs.content}
          >
            jobs
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.tasks.title}
            content={pricingDefinitions.tasks.content}
          >
            tasks
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.events.title}
            content={pricingDefinitions.events.content}
          >
            events
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>Unlimited team members</FeatureItem>
        <FeatureItem checked>30 day log retention</FeatureItem>
        <FeatureItem checked>Priority support</FeatureItem>
        <FeatureItem checked>
          Custom{" "}
          <DefinitionTip
            title={pricingDefinitions.integrations.title}
            content={pricingDefinitions.integrations.content}
          >
            {pricingDefinitions.integrations.title}
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>Role-based access control</FeatureItem>
        <FeatureItem checked>SSO</FeatureItem>
        <FeatureItem checked>On-prem option</FeatureItem>
      </ul>
    </TierContainer>
  );
}

function TierContainer({
  children,
  isHighlighted,
}: {
  children: React.ReactNode;
  isHighlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-[16rem] flex-col rounded-md border p-6",
        isHighlighted ? "border-primary" : "border-grid-bright"
      )}
    >
      {children}
    </div>
  );
}

function Header({
  title,
  cost: flatCost,
  isHighlighted,
}: {
  title: string;
  cost?: number;
  isHighlighted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2
        className={cn("text-xl font-medium", isHighlighted ? "text-primary" : "text-text-dimmed")}
      >
        {title}
      </h2>
      {flatCost === 0 || flatCost ? (
        <h3 className="text-4xl font-medium text-text-bright">
          ${flatCost}
          <span className="text-2sm font-normal tracking-wide text-text-dimmed">/month</span>
        </h3>
      ) : (
        <h2 className="text-4xl font-medium">Custom</h2>
      )}
    </div>
  );
}

function TierLimit({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <hr className="my-[1.9rem]" />
      <div className="mb-[0.6rem] mt-6 font-sans text-sm font-normal text-text-bright">
        {children}
      </div>
    </div>
  );
}

function FeatureItem({ checked, children }: { checked?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {checked ? (
        <CheckIcon className="h-4 w-4 text-primary" />
      ) : (
        <XMarkIcon className="h-4 w-4 text-charcoal-500" />
      )}
      <div
        className={cn(
          "font-sans text-sm font-normal",
          checked ? "text-text-bright" : "text-text-dimmed"
        )}
      >
        {children}
      </div>
    </li>
  );
}
