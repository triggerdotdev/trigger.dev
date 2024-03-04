import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/20/solid";
import { SimpleTooltip } from "./Tooltip";
import { Link } from "@remix-run/react";

const variations = {
  primary: {
    label: "extra-small/bright",
    value: "extra-small",
  },
  secondary: {
    label: "extra-extra-small/caps",
    value: "extra-small/bright",
  },
} as const;

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
        layout === "vertical" && "flex-col",
        variant === "primary" ? "gap-x-1 gap-y-0" : "gap-x-1 gap-y-0.5",
        className
      )}
    >
      <Paragraph variant={variation.label}>{label}</Paragraph>
      <>
        {href ? (
          <ValueButton value={value} href={href} variant={variant} />
        ) : (
          <Paragraph variant={variation.value}>{value}</Paragraph>
        )}
      </>
    </div>
  );
}

type ValueButtonStackProps = {
  value: React.ReactNode;
  href: string;
  variant?: keyof typeof variations;
};

function ValueButton({ value, href, variant = "secondary" }: ValueButtonStackProps) {
  const variation = variations[variant];

  const isExternalUrl = href.startsWith("http");

  if (!isExternalUrl) {
    return (
      <Paragraph variant={variation.value}>
        <Link to={href} reloadDocument className="underline underline-offset-2">
          {value}
        </Link>
      </Paragraph>
    );
  }

  return (
    <SimpleTooltip
      side="bottom"
      button={
        <Paragraph variant={variation.value}>
          <a href={href} className="underline underline-offset-2" target="_blank">
            {value}
            <ArrowTopRightOnSquareIcon className="ml-1 inline-block h-4 w-4 text-text-dimmed" />
          </a>
        </Paragraph>
      }
      content={href}
    />
  );
}
