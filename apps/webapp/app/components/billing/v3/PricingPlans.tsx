import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { FreePlanDefinition, Limits, PaidPlanDefinition, Plans } from "@trigger.dev/billing/v3";
import { DefinitionTip } from "~/components/DefinitionTooltip";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

type PricingPlansProps = {
  plans: Plans;
};

const pricingDefinitions = {
  usage: {
    title: "Usage",
    content: "The compute cost when tasks are executing.",
  },
  freeUsage: {
    title: "Free usage",
    content: "Requires a verified GitHub account.",
  },
  concurrentRuns: {
    title: "Concurrent runs",
    content: "The number of runs that can be executed at the same time.",
  },
  taskRun: {
    title: "Task runs",
    content: "A single execution of a task.",
  },
  tasks: {
    title: "Tasks",
    content:
      "Tasks are functions that can run for a long time and provide strong resilience to failure.",
  },
  environment: {
    title: "Environments",
    content: "The different environments available for running your tasks.",
  },
  schedules: {
    title: "Schedules",
    content: "You can attach recurring schedules to tasks using CRON syntax.",
  },
  alerts: {
    title: "Alert destination",
    content:
      "A single email address, Slack channel, or webhook URL that you want to send alerts to.",
  },
};

export function PricingPlans({ plans }: PricingPlansProps) {
  return (
    <div className="flex w-full flex-col">
      <div className="flex flex-col lg:flex-row">
        <TierFree plan={plans.free} />
        <TierHobby plan={plans.hobby} />
        <TierPro plan={plans.pro} />
      </div>
      <div className="mt-4">
        <TierEnterprise />
      </div>
    </div>
  );
}

export function TierFree({ plan }: { plan: FreePlanDefinition }) {
  return (
    <TierContainer>
      <PricingHeader title="Free" cost={0} />
      <TierLimit href="https://trigger.dev/pricing#computePricing">
        ${plan.limits.includedUsage} free usage
      </TierLimit>
      <input type="hidden" name="type" value="free" />
      <div className="py-6">
        <Button variant="tertiary/large" fullWidth className="text-md font-medium">
          Unlock free plan
        </Button>
      </div>
      <ul className="flex flex-col gap-2.5">
        <ConcurrentRuns limits={plan.limits} />
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.tasks.title}
            content={pricingDefinitions.tasks.content}
          >
            tasks
          </DefinitionTip>
        </FeatureItem>
        <TeamMembers limits={plan.limits} />
        <Environments limits={plan.limits} />
        <Schedules limits={plan.limits} />
        <LogRetention limits={plan.limits} />
        <SupportLevel limits={plan.limits} />
        <Alerts limits={plan.limits} />
      </ul>
    </TierContainer>
  );
}

function ConcurrentRuns({ limits }: { limits: Limits }) {
  return (
    <FeatureItem checked>
      {limits.concurrentRuns.number}
      {limits.concurrentRuns.canExceed ? "+" : ""}{" "}
      <DefinitionTip
        title={pricingDefinitions.concurrentRuns.title}
        content={pricingDefinitions.concurrentRuns.content}
      >
        concurrent runs
      </DefinitionTip>
    </FeatureItem>
  );
}

function TeamMembers({ limits }: { limits: Limits }) {
  return (
    <FeatureItem checked>
      {limits.teamMembers.number}
      {limits.concurrentRuns.canExceed ? "+" : ""} team members
    </FeatureItem>
  );
}

function Environments({ limits }: { limits: Limits }) {
  return (
    <FeatureItem checked>
      {limits.hasStagingEnvironment ? "Dev, Staging and Prod" : "Dev and Prod"}{" "}
      <DefinitionTip
        title={pricingDefinitions.environment.title}
        content={pricingDefinitions.environment.content}
      >
        environments
      </DefinitionTip>
    </FeatureItem>
  );
}

function Schedules({ limits }: { limits: Limits }) {
  return (
    <FeatureItem checked>
      {limits.schedules.number}
      {limits.schedules.canExceed ? "+" : ""}{" "}
      <DefinitionTip
        title={pricingDefinitions.schedules.title}
        content={pricingDefinitions.schedules.content}
      >
        schedules
      </DefinitionTip>
    </FeatureItem>
  );
}

function LogRetention({ limits }: { limits: Limits }) {
  return <FeatureItem checked>{limits.logRetentionDays.number} day log retention</FeatureItem>;
}

function SupportLevel({ limits }: { limits: Limits }) {
  return (
    <FeatureItem checked>
      {limits.support === "community" ? "Community support" : "Dedicated Slack support"}
    </FeatureItem>
  );
}

function Alerts({ limits }: { limits: Limits }) {
  if (limits.alerts.number === 0) {
    return (
      <FeatureItem>
        <DefinitionTip
          title={pricingDefinitions.alerts.title}
          content={pricingDefinitions.alerts.content}
        >
          Alert destinations
        </DefinitionTip>
      </FeatureItem>
    );
  }

  return (
    <FeatureItem checked>
      {limits.alerts.number}
      {limits.alerts.canExceed ? "+" : ""}{" "}
      <DefinitionTip
        title={pricingDefinitions.alerts.title}
        content={pricingDefinitions.alerts.content}
      >
        alert destinations
      </DefinitionTip>
    </FeatureItem>
  );
}

export function TierHobby({ plan }: { plan: PaidPlanDefinition }) {
  return (
    <TierContainer isHighlighted>
      <PricingHeader title="Hobby" isHighlighted cost={10} />
      <TierLimit href="https://trigger.dev/pricing#computePricing">$10 usage included</TierLimit>
      <div className="py-6">
        <Button variant="primary/large" fullWidth className="text-md font-medium">
          Select plan
        </Button>
      </div>
      <ul className="flex flex-col gap-2.5">
        <ConcurrentRuns limits={plan.limits} />
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.tasks.title}
            content={pricingDefinitions.tasks.content}
          >
            tasks
          </DefinitionTip>
        </FeatureItem>
        <TeamMembers limits={plan.limits} /> <Environments limits={plan.limits} />
        <Schedules limits={plan.limits} />
        <LogRetention limits={plan.limits} />
        <SupportLevel limits={plan.limits} />
        <Alerts limits={plan.limits} />
      </ul>
    </TierContainer>
  );
}

export function TierPro({ plan }: { plan: PaidPlanDefinition }) {
  return (
    <TierContainer>
      <PricingHeader title="Pro" cost={50} />
      <TierLimit href="https://trigger.dev/pricing#computePricing">$50 usage included</TierLimit>
      <div className="py-6">
        <Button variant="tertiary/large" fullWidth className="text-md font-medium">
          Select plan
        </Button>
      </div>
      <ul className="flex flex-col gap-2.5">
        <ConcurrentRuns limits={plan.limits} />
        <FeatureItem checked>
          Unlimited{" "}
          <DefinitionTip
            title={pricingDefinitions.tasks.title}
            content={pricingDefinitions.tasks.content}
          >
            tasks
          </DefinitionTip>
        </FeatureItem>
        <TeamMembers limits={plan.limits} />
        <Environments limits={plan.limits} />
        <Schedules limits={plan.limits} />
        <LogRetention limits={plan.limits} />
        <SupportLevel limits={plan.limits} />
        <Alerts limits={plan.limits} />
      </ul>
    </TierContainer>
  );
}

export function TierEnterprise() {
  return (
    <TierContainer>
      <h2 className="text-xl font-medium text-text-dimmed">Enterprise</h2>
      <hr className="mb-5 mt-2 border-grid-dimmed" />
      <div className="flex flex-col-reverse items-center justify-between gap-4 lg:flex-row">
        <div className="flex w-full flex-wrap gap-2 lg:flex-nowrap">
          <h3 className="mb-3 w-full lg:mb-0 lg:text-balance">
            A custom plan tailored to your requirements
          </h3>
          <ul className="flex w-full flex-col gap-y-3 lg:gap-y-1">
            <FeatureItem checked checkedColor="bright">
              All Pro plan features +
            </FeatureItem>
            <FeatureItem checked checkedColor="bright">
              Custom log retention
            </FeatureItem>
          </ul>
          <ul className="flex w-full flex-col gap-y-3 lg:gap-y-1">
            <FeatureItem checked checkedColor="bright">
              Priority support
            </FeatureItem>
            <FeatureItem checked checkedColor="bright">
              Role-based access control
            </FeatureItem>
          </ul>
          <ul className="flex w-full flex-col gap-y-3 lg:gap-y-1">
            <FeatureItem checked checkedColor="bright">
              SOC 2 report
            </FeatureItem>
            <FeatureItem checked checkedColor="bright">
              SSO
            </FeatureItem>
          </ul>
        </div>
        <LinkButton
          to="https://trigger.dev/contact"
          variant="tertiary/large"
          className="lg:max-w-[12rem]"
          fullWidth
        >
          Contact us
        </LinkButton>
      </div>
    </TierContainer>
  );
}

function TierContainer({
  children,
  isHighlighted,
  className,
}: {
  children: React.ReactNode;
  isHighlighted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-[16rem] flex-col p-6",
        isHighlighted ? "border border-primary" : "border border-grid-dimmed",
        className
      )}
    >
      {children}
    </div>
  );
}

function PricingHeader({
  title,
  cost: flatCost,
  isHighlighted,
  per = "/month",
  maximumFractionDigits = 0,
}: {
  title: string;
  cost?: number;
  isHighlighted?: boolean;
  per?: string;
  maximumFractionDigits?: number;
}) {
  const dollarFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  });

  return (
    <div className="flex flex-col gap-2">
      <h2
        className={cn("text-xl font-medium", isHighlighted ? "text-primary" : "text-text-dimmed")}
      >
        {title}
      </h2>
      {flatCost === 0 || flatCost ? (
        <h3 className="text-4xl font-medium tabular-nums text-text-bright">
          {dollarFormatter.format(flatCost)}
          <span className="ml-1 text-sm font-normal tracking-wide text-text-dimmed">{per}</span>
        </h3>
      ) : (
        <h2 className="text-4xl font-medium">Custom</h2>
      )}
    </div>
  );
}

function TierLimit({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <>
      {href ? (
        <div>
          <hr className="my-6 border-grid-bright" />
          <a
            href={href}
            className="hover:decoration-bright font-sans text-lg font-normal text-text-bright underline decoration-charcoal-500 underline-offset-4 transition"
          >
            {children}
          </a>
        </div>
      ) : (
        <div>
          <hr className="my-6 border-grid-bright" />
          <div className="font-sans text-lg font-normal text-text-bright">{children}</div>
        </div>
      )}
    </>
  );
}

function FeatureItem({
  checked,
  checkedColor = "primary",
  children,
}: {
  checked?: boolean;
  checkedColor?: "primary" | "bright";
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      {checked ? (
        <CheckIcon
          className={cn(
            "h-4 w-4 min-w-4",
            checkedColor === "primary" ? "text-primary" : "text-text-bright"
          )}
        />
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
