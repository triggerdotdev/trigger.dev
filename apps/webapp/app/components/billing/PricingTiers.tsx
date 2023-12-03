import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { ActiveSubscription, Plan, Plans, SetPlanBodySchema } from "@trigger.dev/billing";
import { cn } from "~/utils/cn";
import { DefinitionTip } from "../DefinitionTooltip";
import { Button, LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";
import SegmentedControl from "../primitives/SegmentedControl";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { Spinner } from "../primitives/Spinner";

const pricingDefinitions = {
  concurrentRuns: {
    title: "Concurrent Runs",
    content: "The number of Runs that can be executed at the same time.",
  },
  jobRuns: {
    title: "Job Runs",
    content: "A single execution of a Job.",
  },
  jobs: {
    title: "Jobs",
    content: "A Job is like a function that is triggered by an event and performs a Run.",
  },
  tasks: {
    title: "Tasks",
    content: "The individual building blocks of a Job Run.",
  },
  events: {
    title: "Events",
    content: "Events allow you to run Jobs from your own code",
  },
  integrations: {
    title: "Integrations",
    content: "Custom Integrations to authenticate and use your internal APIs.",
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
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

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
        {buttonPath ? (
          <LinkButton
            variant="secondary/large"
            fullWidth
            className="text-md my-6 font-medium"
            to={buttonPath}
          >
            {actionText}
          </LinkButton>
        ) : (
          <Button
            variant="secondary/large"
            fullWidth
            className="text-md my-6 font-medium"
            disabled={isLoading || isCurrentPlan}
            LeadingIcon={isLoading ? "spinner-white" : undefined}
          >
            {isLoading ? "Updating plan" : actionText}
          </Button>
        )}
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
              Jobs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.tasks.title}
              content={pricingDefinitions.tasks.content}
            >
              Tasks
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.events.title}
              content={pricingDefinitions.events.content}
            >
              Events
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>Unlimited team members</FeatureItem>
          <FeatureItem checked>24 hour log retention</FeatureItem>
          <FeatureItem checked>Community support</FeatureItem>
          <FeatureItem>Custom Integrations</FeatureItem>
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
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

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

        <div className="mb-2 mt-6 font-sans text-sm font-normal text-bright">
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
          onChange={(v) => setConcurrentBracketCode(v)}
        />
        <Button
          variant="primary/large"
          fullWidth
          className="text-md my-6 font-medium"
          type="submit"
          disabled={isLoading || isCurrentPlan}
          LeadingIcon={isLoading ? "spinner-white" : undefined}
        >
          {isLoading ? "Updating plan" : actionText}
        </Button>
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
            <DefinitionTip title="Runs volume discount" content={<RunsVolumeDiscountTable />}>
              {"<"} ${(mostExpensiveRunCost * 1000).toFixed(2)}/1k Runs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.jobs.title}
              content={pricingDefinitions.jobs.content}
            >
              Jobs
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.tasks.title}
              content={pricingDefinitions.tasks.content}
            >
              Tasks
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>
            Unlimited{" "}
            <DefinitionTip
              title={pricingDefinitions.events.title}
              content={pricingDefinitions.events.content}
            >
              Events
            </DefinitionTip>
          </FeatureItem>
          <FeatureItem checked>Unlimited team members</FeatureItem>
          <FeatureItem checked>7 day log retention</FeatureItem>
          <FeatureItem checked>Dedicated Slack support</FeatureItem>
          <FeatureItem>Custom Integrations</FeatureItem>
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
      <Button variant="secondary/large" fullWidth className="text-md my-6 font-medium">
        Contact us
      </Button>
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
            Jobs
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.tasks.title}
            content={pricingDefinitions.tasks.content}
          >
            Tasks
          </DefinitionTip>
        </FeatureItem>
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.events.title}
            content={pricingDefinitions.events.content}
          >
            Events
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
        isHighlighted ? "border-indigo-500" : "border-border"
      )}
    >
      {children}
    </div>
  );
}

function RunsVolumeDiscountTable() {
  const runsVolumeDiscountRow =
    "flex justify-between border-b border-border last:pb-0 last:border-none py-2";
  return (
    <ul>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">First 10k/mo</Paragraph>
        <Paragraph variant="small">Free</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">10k–20k</Paragraph>
        <Paragraph variant="small">$1.25/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">20k–150k</Paragraph>
        <Paragraph variant="small">$0.88/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">150k–500k</Paragraph>
        <Paragraph variant="small">$0.61/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">500k–1m</Paragraph>
        <Paragraph variant="small">$0.43/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">1m–2.5m</Paragraph>
        <Paragraph variant="small">$0.30/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">2.5m–6.25m</Paragraph>
        <Paragraph variant="small">$0.21/1,000</Paragraph>
      </li>
      <li className={runsVolumeDiscountRow}>
        <Paragraph variant="small">6.25m +</Paragraph>
        <Paragraph variant="small">$0.14/1,000</Paragraph>
      </li>
    </ul>
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
      <h2 className={cn("text-xl font-medium", isHighlighted ? "text-indigo-500" : "text-dimmed")}>
        {title}
      </h2>
      {flatCost === 0 || flatCost ? (
        <h3 className="text-4xl font-medium">
          ${flatCost}
          <span className="text-2sm font-normal tracking-wide text-dimmed">/month</span>
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
      <div className="mb-[0.6rem] mt-6 font-sans text-sm font-normal text-bright">{children}</div>
    </div>
  );
}

function FeatureItem({ checked, children }: { checked?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {checked ? (
        <CheckIcon className="h-4 w-4 text-green-500" />
      ) : (
        <XMarkIcon className="h-4 w-4 text-slate-500" />
      )}
      <div className={cn("font-sans text-sm font-normal", checked ? "text-bright" : "text-dimmed")}>
        {children}
      </div>
    </li>
  );
}
