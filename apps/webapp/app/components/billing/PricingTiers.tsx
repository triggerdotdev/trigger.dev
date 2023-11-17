import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";

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
      {pricedMetric ? <div>hi</div> : <hr className="my-4" />}

      <Paragraph variant="small/bright" className="">
        {description}
      </Paragraph>
    </div>
  );
}
