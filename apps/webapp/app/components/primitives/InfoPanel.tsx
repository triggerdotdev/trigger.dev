import { cn } from "~/utils/cn";
import { Header2 } from "./Headers";
import { Paragraph } from "./Paragraph";
import { type ReactNode } from "react";

const variants = {
  info: {
    panelStyle: "border-grid-bright bg-background-bright rounded-md border p-4 gap-3",
  },
  upgrade: {
    panelStyle: "border-indigo-400/20 bg-indigo-800/10 rounded-md border p-4 gap-3",
  },
  minimal: {
    panelStyle: "max-w-full w-full py-3 px-3 gap-2",
  },
};

type InfoPanelVariant = keyof typeof variants;

type Props = {
  title?: string;
  children: React.ReactNode;
  accessory?: ReactNode;
  icon: React.ComponentType<any>;
  iconClassName?: string;
  variant?: InfoPanelVariant;
  panelClassName?: string;
};

export function InfoPanel({
  title,
  children,
  accessory,
  icon,
  iconClassName,
  variant = "info",
  panelClassName = "max-w-sm",
}: Props) {
  const Icon = icon;
  const variantStyle = variants[variant];

  return (
    <div
      className={cn(
        variantStyle.panelStyle,
        title ? "flex-col" : "",
        "flex h-fit items-start",
        panelClassName
      )}
    >
      <div className={cn("flex items-center gap-2", accessory ? "w-full justify-between" : "")}>
        <Icon className={cn("size-5", iconClassName)} />

        {accessory}
      </div>
      <div className="flex flex-col gap-1">
        {title && <Header2 className="text-text-bright">{title}</Header2>}
        {typeof children === "string" ? (
          <Paragraph variant={"small"} className="text-text-dimmed">
            {children}
          </Paragraph>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
