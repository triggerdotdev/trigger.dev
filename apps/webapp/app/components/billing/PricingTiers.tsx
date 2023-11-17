import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";
import * as Slider from "@radix-ui/react-slider";

export function PricingTiers({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-4">{children}</div>;
}

export function TierFree() {
  return (
    <TierContainer>
      <Header title="Free" flatCost={0} />

      <TierLimit description="1 concurrent Run / month" />
    </TierContainer>
  );
}

export function TierPro() {
  return (
    <TierContainer isHighlighted>
      <Header title="Pro" flatCost={25} />
      <TierLimit pricedMetric description="Up to 5 concurrent Runs / month" />
    </TierContainer>
  );
}

export function TierEnterprise() {
  return (
    <TierContainer>
      <Header title="Enterprise" />

      <TierLimit description="Flexible concurrent Runs / month" />
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
        "flex min-w-[16rem] flex-col rounded-md border p-6",
        isHighlighted ? "border-indigo-500" : "border-border"
      )}
    >
      {children}
    </div>
  );
}

function Header({ title, flatCost }: { title: string; flatCost?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xl font-medium text-dimmed">{title}</h2>
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

function TierLimit({ description, pricedMetric }: { description: string; pricedMetric?: boolean }) {
  return (
    <div>
      {pricedMetric ? <PricingSlider /> : <hr className="my-[1.6rem]" />}

      <Paragraph variant="small/bright" className="">
        {description}
      </Paragraph>
    </div>
  );
}

export function PricingSlider() {
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
