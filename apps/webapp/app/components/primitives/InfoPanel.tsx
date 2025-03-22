import { cn } from "~/utils/cn";
import { LinkButton } from "./Buttons";
import { Header2 } from "./Headers";
import { Paragraph } from "./Paragraph";

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
  to?: string;
  buttonLabel?: string;
  buttonVariant?: React.ComponentProps<typeof LinkButton>["variant"];
  buttonLeadingIcon?: React.ComponentProps<typeof LinkButton>["LeadingIcon"];
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
  buttonVariant = "secondary/small",
  buttonLeadingIcon,
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
      <div className={cn("flex items-center gap-2", to ? "w-full justify-between" : "")}>
        <Icon className={cn("size-5", iconClassName)} />

        {to && (
          <LinkButton to={to} variant={buttonVariant} LeadingIcon={buttonLeadingIcon}>
            {buttonLabel}
          </LinkButton>
        )}
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
