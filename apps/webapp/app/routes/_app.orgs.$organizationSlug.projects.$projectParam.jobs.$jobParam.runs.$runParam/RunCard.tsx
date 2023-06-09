import { DisplayProperty, StyleName } from "@/../../packages/internal/src";
import { useEffect, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Callout } from "~/components/primitives/Callout";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { formatDuration } from "~/utils";
import { cn } from "~/utils/cn";

type RunPanelProps = {
  selected?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  styleName?: StyleName;
};

export function RunPanel({
  selected = false,
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

export function RunPanelError({
  text,
  error,
  stackTrace,
}: {
  text: string;
  error?: string;
  stackTrace?: string;
}) {
  return (
    <div>
      <Callout variant="error" className="mb-2">
        {text}
      </Callout>
      {error && <CodeBlock language="json" code={error} />}
      {stackTrace && <CodeBlock language="json" code={stackTrace} />}
    </div>
  );
}

export function RunPanelIconSection({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-x-8 gap-y-2", className)}>
      {children}
    </div>
  );
}

export function RunPanelDivider() {
  return <div className="mb-4 border-b border-slate-700 pb-4" />;
}

export function RunPanelIconProperty({
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

export function RunPanelProperties({
  properties,
  className,
  layout = "horizontal",
}: {
  properties: DisplayProperty[];
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
      {properties.map(({ label, text, url }, index) => (
        <LabelValueStack key={index} label={label} value={text} href={url} />
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

const updateInterval = 100;

export function UpdatingDuration({ start, end }: { start?: Date; end?: Date }) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    if (end) return;

    const interval = setInterval(() => {
      setNow(new Date());
    }, updateInterval);

    return () => clearInterval(interval);
  }, [end]);

  return (
    <span>
      {formatDuration(start, end || now, {
        style: "short",
        maxDecimalPoints: 0,
      })}
    </span>
  );
}

export function UpdatingDelay({ delayUntil }: { delayUntil: Date }) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    const interval = setInterval(() => {
      const date = new Date();
      if (date > delayUntil) {
        setNow(delayUntil);
        return;
      }
      setNow(date);
    }, updateInterval);

    return () => clearInterval(interval);
  }, [delayUntil]);

  return (
    <RunPanelIconProperty
      icon="countdown"
      label="Delay finishes in"
      value={formatDuration(now, delayUntil, {
        style: "long",
        maxDecimalPoints: 0,
      })}
    />
  );
}
