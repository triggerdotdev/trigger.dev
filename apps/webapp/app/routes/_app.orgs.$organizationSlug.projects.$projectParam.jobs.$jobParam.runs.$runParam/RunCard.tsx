import { Style, StyleName } from "@/../../packages/internal/src";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

type RunPanelProps = {
  selected: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  styleName?: StyleName;
};

export function RunPanel({
  selected,
  children,
  onClick,
  className,
  styleName = "normal",
}: RunPanelProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition duration-150",
        styleName === "normal" && "bg-slate-900",
        selected
          ? "border-green-500"
          : styleName === "normal"
          ? "border-slate-850"
          : "border-slate-900",
        onClick && "cursor-pointer",
        onClick && !selected && "hover:border-green-500/30",
        className
      )}
      onClick={() => onClick && onClick()}
    >
      {children}
    </div>
  );
}

type RunPanelHeaderProps = {
  icon: React.ReactNode;
  title: React.ReactNode;
  accessory?: React.ReactNode;
  styleName?: StyleName;
};

export function RunPanelHeader({
  icon,
  title,
  accessory,
  styleName = "normal",
}: RunPanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-2",
        styleName === "normal"
          ? "h-10 border-b border-slate-850 bg-midnight-850 py-2"
          : "pt-2"
      )}
    >
      <div className="flex items-center gap-2">
        {typeof icon === "string" ? (
          <NamedIcon name={icon} className="h-5 w-5" />
        ) : (
          icon
        )}
        {typeof title === "string" ? (
          <Paragraph variant="small/bright">{title}</Paragraph>
        ) : (
          title
        )}
      </div>
      <div className="flex items-center gap-2">{accessory}</div>
    </div>
  );
}

type RunPanelIconTitleProps = {
  icon?: string | null;
  title: string;
};

export function RunPanelIconTitle({ icon, title }: RunPanelIconTitleProps) {
  return (
    <div className="flex items-center gap-1">
      {icon && <NamedIcon name={icon} className="h-5 w-5" />}
      <Paragraph variant="small/bright">{title}</Paragraph>
    </div>
  );
}

export function RunPanelBody({ children }: { children: React.ReactNode }) {
  return <div className="p-4">{children}</div>;
}

const variantClasses: Record<string, string> = {
  log: "",
  error: "text-rose-500",
  warn: "text-yellow-500",
  info: "",
  debug: "",
};

export function RunPanelDescription({
  text,
  variant,
}: {
  text: string;
  variant?: string;
}) {
  return (
    <Paragraph
      variant="small"
      className={cn(variant && variantClasses[variant])}
    >
      {text}
    </Paragraph>
  );
}

export function RunPanelIconSection({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-wrap gap-x-8 gap-y-2">{children}</div>;
}

export function RunPanelIconElement({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-sm border border-slate-800 bg-slate-850">
        <NamedIcon name={icon} className="h-5 w-5" />
      </div>
      <div className="flex flex-col gap-0.5">
        <Paragraph variant="extra-extra-small/caps">{label}</Paragraph>
        <Paragraph variant="extra-small/bright">{value}</Paragraph>
      </div>
    </div>
  );
}

export function RunPanelElements({
  elements,
  className,
  layout = "horizontal",
}: {
  elements: { label: string; value: string }[];
  className?: string;
  layout?: "horizontal" | "vertical";
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-x-8 gap-y-1",
        layout === "horizontal" ? "flex-wrap" : "flex-col",
        className
      )}
    >
      {elements.map(({ label, value }, index) => (
        <LabelValueStack key={index} label={label} value={value} />
      ))}
    </div>
  );
}

export function TaskSeparator({ depth }: { depth: number }) {
  return (
    <div
      className="h-4 w-4 border-r border-slate-600"
      style={{ marginLeft: `${depth}rem` }}
    />
  );
}
