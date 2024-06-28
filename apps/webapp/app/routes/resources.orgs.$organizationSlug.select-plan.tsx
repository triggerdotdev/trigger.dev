import {
  CheckIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form, useLocation, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs } from "@remix-run/server-runtime";
import {
  FreePlanDefinition,
  FreeTierStatus,
  Limits,
  PaidPlanDefinition,
  Plans,
  SetPlanBody,
  SubscriptionResult,
} from "@trigger.dev/billing/v3";
import { GitHubLightIcon } from "@trigger.dev/companyicons";
import { z } from "zod";
import { DefinitionTip } from "~/components/DefinitionTooltip";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { setPlan } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";

const Params = z.object({
  organizationSlug: z.string(),
});

const schema = z.object({
  type: z.enum(["free", "paid"]),
  planCode: z.string().optional(),
  callerPath: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { organizationSlug } = Params.parse(params);

  const userId = await requireUserId(request);

  const formData = Object.fromEntries(await request.formData());
  const form = schema.parse(formData);

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw redirectWithErrorMessage(form.callerPath, request, "Organization not found");
  }

  let payload: SetPlanBody;

  switch (form.type) {
    case "free": {
      payload = {
        type: "free" as const,
        userId,
      };
      break;
    }
    case "paid": {
      if (form.planCode === undefined) {
        throw redirectWithErrorMessage(form.callerPath, request, "Not a valid plan");
      }
      payload = {
        type: "paid" as const,
        planCode: form.planCode,
        userId,
      };
      break;
    }
  }

  return setPlan(organization, request, form.callerPath, payload);
}

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

type PricingPlansProps = {
  plans: Plans;
  subscription?: SubscriptionResult;
  organizationSlug: string;
};

export function PricingPlans({ plans, subscription, organizationSlug }: PricingPlansProps) {
  return (
    <div className="flex w-full flex-col">
      <div className="flex flex-col lg:flex-row">
        <TierFree
          plan={plans.free}
          subscription={subscription}
          organizationSlug={organizationSlug}
        />
        <TierHobby
          plan={plans.hobby}
          organizationSlug={organizationSlug}
          subscription={subscription}
        />
        <TierPro plan={plans.pro} organizationSlug={organizationSlug} subscription={subscription} />
      </div>
      <div className="mt-4">
        <TierEnterprise />
      </div>
    </div>
  );
}

export function TierFree({
  plan,
  subscription,
  organizationSlug,
}: {
  plan: FreePlanDefinition;
  subscription?: SubscriptionResult;
  organizationSlug: string;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const formAction = `/resources/orgs/${organizationSlug}/select-plan`;
  const isLoading = navigation.formAction === formAction;

  const status = subscription?.freeTierStatus ?? "requires_connect";

  return (
    <TierContainer>
      <div className="relative">
        <PricingHeader title={plan.title} cost={0} />
        {status === "approved" && (
          <SimpleTooltip
            buttonClassName="absolute right-1 top-1"
            button={
              <div className="flex items-center gap-1 rounded-sm bg-green-900 px-2 py-1 text-xs text-green-300">
                <ShieldCheckIcon className="size-4" />
                <span>GitHub verified</span>
              </div>
            }
            content={
              <>
                <Paragraph variant="small" spacing>
                  You have connected a verified GitHub account.
                </Paragraph>
                <Paragraph variant="small">
                  This is required for the free plan to prevent scammers and malicious use of our
                  platform.
                </Paragraph>
              </>
            }
            variant="dark"
          />
        )}
      </div>
      {status === "rejected" ? (
        <div>
          <hr className="my-6 border-grid-bright" />
          <div className="flex flex-col gap-2 rounded-sm border border-warning p-4">
            <ExclamationTriangleIcon className="h-6 w-6 text-warning" />
            <Paragraph variant="small/bright">
              Your Trigger.dev account failed to be verified for the free plan because your GitHub
              account is too new. We require verification to prevent scammers and malicious use of
              our platform.
            </Paragraph>
            <Paragraph variant="small/bright">
              You can still select a paid plan to continue or if you think this is a mistake, get in
              touch.
            </Paragraph>
          </div>
        </div>
      ) : (
        <Form action={formAction} method="post" id="subscribe">
          <input type="hidden" name="type" value="free" />
          <input type="hidden" name="callerPath" value={location.pathname} />
          <TierLimit href="https://trigger.dev/pricing#computePricing">
            ${plan.limits.includedUsage / 100} free usage
          </TierLimit>
          <div className="py-6">
            {status === "requires_connect" ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="tertiary/large"
                    fullWidth
                    className="text-md font-medium"
                    disabled={isLoading}
                    LeadingIcon={isLoading ? Spinner : undefined}
                  >
                    Unlock free plan
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-96">
                  <DialogHeader>Unlock the Free plan</DialogHeader>
                  <div className="flex flex-col items-center gap-3 pt-3">
                    <GitHubLightIcon className="size-12" />
                    <Paragraph variant="small/bright" className="text-center">
                      To unlock the Free plan, we need to verify that you have an active GitHub
                      account.
                    </Paragraph>
                    <Paragraph variant="small" className="text-center">
                      This prevents scammers and malicious use of our platform. We only ask for the
                      minimum permissions to verify your account.
                    </Paragraph>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="primary/medium"
                      fullWidth
                      disabled={isLoading}
                      LeadingIcon={isLoading ? Spinner : undefined}
                      form="subscribe"
                    >
                      Connect to GitHub
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : (
              <Button
                variant="tertiary/large"
                fullWidth
                className="text-md font-medium"
                disabled={
                  isLoading ||
                  subscription?.plan?.type === plan.type ||
                  subscription?.canceledAt !== undefined
                }
                LeadingIcon={
                  isLoading && navigation.formData?.get("planCode") === null ? Spinner : undefined
                }
              >
                {subscription?.plan === undefined
                  ? "Select plan"
                  : subscription.plan.type === "free" || subscription.canceledAt !== undefined
                  ? "Current plan"
                  : `Downgrade to ${plan.title}`}
              </Button>
            )}
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
        </Form>
      )}
    </TierContainer>
  );
}

export function TierHobby({
  plan,
  organizationSlug,
  subscription,
}: {
  plan: PaidPlanDefinition;
  organizationSlug: string;
  subscription?: SubscriptionResult;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const formAction = `/resources/orgs/${organizationSlug}/select-plan`;
  const isLoading = navigation.formAction === formAction;

  return (
    <TierContainer isHighlighted>
      <PricingHeader title={plan.title} isHighlighted cost={plan.tierPrice} />
      <TierLimit href="https://trigger.dev/pricing#computePricing">
        ${plan.limits.includedUsage / 100} usage included
      </TierLimit>
      <Form action={formAction} method="post" id="subscribe">
        <div className="py-6">
          <input type="hidden" name="type" value="paid" />
          <input type="hidden" name="planCode" value={plan.code} />
          <input type="hidden" name="callerPath" value={location.pathname} />
          <Button
            variant="primary/large"
            fullWidth
            className="text-md font-medium"
            disabled={
              isLoading ||
              (subscription?.plan?.code === plan.code && subscription.canceledAt === undefined)
            }
            LeadingIcon={
              isLoading && navigation.formData?.get("planCode") === plan.code ? Spinner : undefined
            }
          >
            {subscription?.plan === undefined
              ? "Select plan"
              : subscription.plan.type === "free" || subscription.canceledAt !== undefined
              ? `Upgrade to ${plan.title}`
              : subscription.plan.code === plan.code
              ? "Current plan"
              : `Downgrade to ${plan.title}`}
          </Button>
        </div>
      </Form>
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

export function TierPro({
  plan,
  organizationSlug,
  subscription,
}: {
  plan: PaidPlanDefinition;
  organizationSlug: string;
  subscription?: SubscriptionResult;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const formAction = `/resources/orgs/${organizationSlug}/select-plan`;
  const isLoading = navigation.formAction === formAction;

  return (
    <TierContainer>
      <PricingHeader title={plan.title} cost={plan.tierPrice} />
      <TierLimit href="https://trigger.dev/pricing#computePricing">
        ${plan.limits.includedUsage / 100} usage included
      </TierLimit>
      <Form action={formAction} method="post" id="subscribe">
        <div className="py-6">
          <input type="hidden" name="type" value="paid" />
          <input type="hidden" name="planCode" value={plan.code} />
          <input type="hidden" name="callerPath" value={location.pathname} />
          <Button
            variant="tertiary/large"
            fullWidth
            className="text-md font-medium"
            disabled={
              isLoading ||
              (subscription?.plan?.code === plan.code && subscription.canceledAt === undefined)
            }
            LeadingIcon={
              isLoading && navigation.formData?.get("planCode") === plan.code ? Spinner : undefined
            }
          >
            {subscription?.plan === undefined
              ? "Select plan"
              : subscription.plan.type === "free" || subscription.canceledAt !== undefined
              ? `Upgrade to ${plan.title}`
              : subscription.plan.code === plan.code
              ? "Current plan"
              : `Upgrade to ${plan.title}`}
          </Button>
        </div>
      </Form>
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
        <div className="flex w-full flex-1 flex-wrap gap-2 lg:flex-nowrap">
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
          className="px-8 lg:max-w-[12rem]"
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
