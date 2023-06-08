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
  href?: string;
  layout?: "horizontal" | "vertical";
  variant?: keyof typeof variations;
  className?: string;
};

export function LabelValueStack({
  label,
  value,
  href,
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
      <Paragraph variant={variation.label}>{label}</Paragraph>
      <Paragraph variant={variation.value}>
        {href ? (
          <a
            href={href}
            className=" underline underline-offset-2"
            target="_blank"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </Paragraph>
    </div>
  );
}
