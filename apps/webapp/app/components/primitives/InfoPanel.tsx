import { LinkButton } from "./Buttons";
import { Header3 } from "./Headers";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";

const variants = {
  info: {
    panelStyle: "border-grid-bright bg-background-bright",
  },
  upgrade: {
    panelStyle: "border-indigo-400/20 bg-indigo-800/10",
  },
};

type InfoPanelVariant = keyof typeof variants;

type Props = {
  title?: string;
  children: React.ReactNode;
  to?: string;
  buttonLabel?: string;
  icon: React.ComponentType<any>;
  iconClassName?: string;
  variant?: InfoPanelVariant;
  panelClassName?: string;
};

export function InfoPanel({
  title,
  children,
  to,
  buttonLabel,
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
        "flex h-fit items-start gap-3 rounded-md border p-4",
        panelClassName
      )}
    >
      <div className={cn("flex items-center gap-2", to ? "w-full justify-between" : "")}>
        <Icon className={cn("size-5", iconClassName)} />

        {to && (
          <LinkButton to={to} variant="secondary/small">
            {buttonLabel}
          </LinkButton>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {title && <Header3 className="text-text-bright">{title}</Header3>}
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
