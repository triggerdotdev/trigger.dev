import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import { Children, Fragment } from "react";
import { Header3 } from "~/components/primitives/Headers";

type RunPanelProps = {
  selected: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
};

export function RunPanel({
  selected,
  children,
  onClick,
  className,
}: RunPanelProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-slate-900 transition duration-150",
        selected ? "border-green-500" : "border-slate-850",
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
};

export function RunPanelHeader({
  icon,
  title,
  accessory,
}: RunPanelHeaderProps) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-slate-850 bg-slate-950 p-2">
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

export function RunPanelDescription({ text }: { text: string }) {
  return (
    <Paragraph variant="small" className="pb-4">
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
        <div key={index} className="flex items-baseline gap-2 overflow-hidden">
          <Paragraph variant="extra-extra-small/caps">{label}</Paragraph>
          <Paragraph
            variant="extra-small/bright"
            className={cn(layout === "horizontal" && "truncate")}
          >
            {value}
          </Paragraph>
        </div>
      ))}
    </div>
  );
}

export function TaskSeparator() {
  return <div className="h-4 w-4 border-r border-slate-600" />;
}
