import { cn } from "~/utils/cn";
import { Paragraph, ParagraphVariant } from "./Paragraph";

const variations: Record<
  string,
  { label: ParagraphVariant; value: ParagraphVariant }
> = {
  primary: {
    label: "extra-small/bright",
    value: "extra-small",
  },
  secondary: {
    label: "extra-extra-small/caps",
    value: "extra-small/bright",
  },
};

type LabelValueStackProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  layout?: "horizontal" | "vertical";
  variant?: keyof typeof variations;
  className?: string;
};

export function LabelValueStack({
  label,
  value,
  layout = "vertical",
  variant = "secondary",
  className,
}: LabelValueStackProps) {
  const variation = variations[variant];

  return (
    <div
      className={cn(
        "flex items-baseline",
        layout === "vertical" ? "flex-col" : "gap-1",
        className
      )}
    >
      <Paragraph variant={variation.label} className="truncate">
        {label}
      </Paragraph>
      <Paragraph variant={variation.value} className="truncate">
        {value}
      </Paragraph>
    </div>
  );
}
