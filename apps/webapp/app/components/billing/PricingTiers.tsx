import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";
import * as Slider from "@radix-ui/react-slider";
import { Button } from "../primitives/Buttons";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/solid";
import SegmentedControl from "../primitives/SegmentedControl";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { Header3 } from "../primitives/Headers";

export function PricingTiers({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 md:flex-row",
        className
      )}
    >
      {children}
    </div>
  );
}

export function TierFree() {
  return (
    <TierContainer>
      <Header title="Free" flatCost={0} />
      <TierLimit>
        Up to 5{" "}
        <DefinitionTip title="Concurrent Runs" content="Description">
          Concurrent Runs
        </DefinitionTip>
      </TierLimit>
      <Button variant="secondary/large" fullWidth className="text-md my-6 font-medium">
        Current Plan
      </Button>
      <ul className="flex flex-col gap-2.5">
        <FeatureItem checked title="Up to 10k Job Runs" />
        <FeatureItem checked title="Unlimited Jobs" />
        <FeatureItem checked title="Unlimited Tasks" />
        <FeatureItem checked title="Unlimited Events" />
        <FeatureItem checked title="Unlimited team members" />
        <FeatureItem checked title="24 hour log retention" />
        <FeatureItem checked title="Community support" />
        <FeatureItem title="Custom integrations" />
        <FeatureItem title="Role-based access control" />
        <FeatureItem title="SSO" />
        <FeatureItem title="On-prem option" />
      </ul>
    </TierContainer>
  );
}

export function TierPro() {
  return (
    <TierContainer isHighlighted>
      <Header title="Pro" isHighlighted flatCost={25} />
      <TierLimit pricedMetric>
        <DefinitionTip title="Concurrent Runs" content="Description">
          Concurrent Runs
        </DefinitionTip>
      </TierLimit>
      <Button variant="primary/large" fullWidth className="text-md my-6 font-medium">
        Upgrade
      </Button>
      <ul className="flex flex-col gap-2.5">
        <FeatureItem checked title="Includes 10k Job Runs, then < $1.30/1,000 Runs" />
        <FeatureItem checked title="Unlimited Jobs" />
        <FeatureItem checked title="Unlimited Tasks" />
        <FeatureItem checked title="Unlimited Events" />
        <FeatureItem checked title="Unlimited team members" />
        <FeatureItem checked title="7 day log retention" />
        <FeatureItem checked title="Dedicated Slack support" />
        <FeatureItem title="Custom integrations" />
        <FeatureItem title="Role-based access control" />
        <FeatureItem title="SSO" />
        <FeatureItem title="On-prem option" />
      </ul>
    </TierContainer>
  );
}

export function TierEnterprise() {
  return (
    <TierContainer>
      <Header title="Enterprise" />
      <TierLimit>
        Flexible{" "}
        <DefinitionTip title="Concurrent Runs" content="Description">
          concurrent Runs
        </DefinitionTip>
      </TierLimit>
      <Button variant="secondary/large" fullWidth className="text-md my-6 font-medium">
        Contact us
      </Button>
      <ul className="flex flex-col gap-2.5">
        <FeatureItem checked title="Flexible Job Runs" />
        <FeatureItem checked title="Unlimited Jobs" />
        <FeatureItem checked title="Unlimited Tasks" />
        <FeatureItem checked title="Unlimited Events" />
        <FeatureItem checked title="Unlimited team members" />
        <FeatureItem checked title="30 day log retention" />
        <FeatureItem checked title="Priority support" />
        <FeatureItem checked title="Custom integrations" />
        <FeatureItem checked title="Role-based access control" />
        <FeatureItem checked title="SSO" />
        <FeatureItem checked title="On-prem option" />
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

function DefinitionTip({
  content,
  children,
  title,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip disableHoverableContent>
        <TooltipTrigger>
          <span className="underline decoration-slate-600 decoration-dashed underline-offset-4 transition hover:decoration-slate-500">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent align="end" side="right" variant="dark" className="">
          <Header3 className="mb-1">{title}</Header3>
          {typeof content === "string" ? (
            <Paragraph variant="small">{content}</Paragraph>
          ) : (
            <div>{content}</div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Header({
  title,
  flatCost,
  isHighlighted,
}: {
  title: string;
  flatCost?: number;
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

function TierLimit({
  children,
  pricedMetric,
}: {
  children: React.ReactNode;
  pricedMetric?: boolean;
}) {
  return (
    <div>
      {pricedMetric ? (
        <>
          <Paragraph variant="small/bright" className="mb-2 mt-6">
            {children}
          </Paragraph>
          <SegmentedControl name={"Concurrent Runs"} options={options} fullWidth />
        </>
      ) : (
        <>
          <hr className="my-[1.9rem]" />
          <Paragraph variant="small/bright" className="mb-[0.6rem]">
            {children}
          </Paragraph>
        </>
      )}
    </div>
  );
}

const options = [
  { label: "Up to 20", value: "20" },
  { label: "Up to 50", value: "50" },
  { label: "Up to 100", value: "100" },
];

function UsageSlider() {
  return (
    <form>
      <Slider.Root
        className="relative my-4 flex h-5 w-full touch-none select-none items-center"
        // It would be nice to set the default value to always be 1 bracket above your current one, up to the max.
        defaultValue={[20]}
        max={100}
        step={5}
      >
        <Slider.Track className="relative h-[8px] grow rounded-full bg-slate-850">
          <Slider.Range className="absolute h-full rounded-full bg-indigo-500" />
        </Slider.Track>
        <Slider.Thumb
          className="block h-5 w-5 rounded-full border-4 border-indigo-500 bg-slate-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-indigo-400 hover:bg-slate-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
          aria-label="Pro tier pricing slider"
        />
      </Slider.Root>
    </form>
  );
}

function FeatureItem({ checked, title }: { checked?: boolean; title: string }) {
  return (
    <li className="flex items-center gap-2">
      {checked ? (
        <CheckIcon className="h-4 w-4 text-green-500" />
      ) : (
        <XMarkIcon className="h-4 w-4 text-slate-500" />
      )}
      <Paragraph variant="small" className={cn(checked ? "text-bright" : "text-dimmed")}>
        {title}
      </Paragraph>
    </li>
  );
}
