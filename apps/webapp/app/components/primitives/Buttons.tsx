import { Link, type LinkProps, NavLink, type NavLinkProps } from "@remix-run/react";
import React, {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { AgentMonoLogo } from "./AgentDotMatrix";
import { ShortcutKey } from "./ShortcutKey";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";
import { Icon, type RenderIcon } from "./Icon";
import { Spinner } from "./Spinner";

const sizes = {
  small: {
    button: "h-6 px-2.5 text-xs",
    icon: "h-3.5 -mx-1",
    iconSpacing: "gap-x-2.5",
    shortcutVariant: "small" as const,
    shortcut: "-ml-0.5 -mr-1.5 justify-self-center",
  },
  // Icon-only small button: fixed width so a row of icon buttons (with different icon
  // aspect ratios) lines up, e.g. the queue block accessories.
  "small-icon": {
    button: "h-6 min-w-[34px] px-2 text-xs",
    icon: "h-3.5 -mx-1",
    iconSpacing: "gap-x-2.5",
    shortcutVariant: "small" as const,
    shortcut: "-ml-0.5 -mr-1.5 justify-self-center",
  },
  medium: {
    button: "h-8 px-3 text-sm",
    icon: "h-4 -mx-1",
    iconSpacing: "gap-x-2.5",
    shortcutVariant: "medium" as const,
    shortcut: "-ml-0.5 -mr-1.5 rounded justify-self-center",
  },
  large: {
    button: "h-10 px-2 text-base font-medium",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5",
  },
  "extra-large": {
    button: "h-12 px-2 text-base font-medium",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5",
  },
};

type Size = keyof typeof sizes;

const theme = {
  primary: {
    textColor: "text-white transition group-disabled/button:text-white/60",
    button:
      // Shares --color-accent-fill with the switch's checked track, so the two
      // accents can't drift. The border is a fixed bevel one stop up the ramp,
      // like the indigo pair it replaces.
      "bg-accent-fill border border-lavender-500 group-hover/button:bg-lavender-500 group-hover/button:border-lavender-400 group-disabled/button:opacity-50 group-disabled/button:bg-accent-fill group-disabled/button:border-lavender-500 group-disabled/button:pointer-events-none",
    shortcut:
      "border-white/40 text-white group-hover/button:border-white/60 group-hover/button:text-white",
    icon: "text-white",
  },
  secondary: {
    textColor: "text-text-bright transition group-disabled/button:text-text-dimmed/80",
    button:
      // On light, hover darkens off white. On the dark themes bg-secondary is
      // charcoal-650, so hover steps one stop up the scale to charcoal-600
      // (surface-control) - background-raised is charcoal-700, i.e. darker.
      "bg-secondary border border-border-bright/50 shadow-xs group-hover/button:bg-background-raised dark:group-hover/button:bg-surface-control group-disabled/button:bg-secondary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-text-bright",
  },
  tertiary: {
    textColor: "text-text-bright transition group-disabled/button:text-text-dimmed/80",
    button:
      "bg-tertiary group-hover/button:bg-surface-control group-disabled/button:bg-tertiary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-text-bright",
  },
  minimal: {
    textColor: "text-text-dimmed group-disabled/button:text-text-dimmed transition",
    button:
      "bg-transparent group-hover/button:bg-tertiary disabled:opacity-50 group-disabled/button:bg-transparent group-disabled/button:pointer-events-none",
    shortcut:
      "border-dimmed/40 text-text-dimmed group-hover/button:text-text-bright/80 group-hover/button:border-dimmed/60",
    icon: "text-text-dimmed",
  },
  danger: {
    textColor: "text-white transition group-disabled/button:text-white/80",
    button:
      "bg-error group-hover/button:bg-rose-500 disabled:opacity-50 group-disabled/button:bg-error group-disabled/button:pointer-events-none",
    shortcut: "border-white text-white group-hover/button:border-white/60",
    icon: "text-white",
  },
  warning: {
    textColor: "text-warning transition group-disabled/button:text-warning/60",
    button:
      "bg-warning/10 border border-warning/20 group-hover/button:bg-warning/20 group-hover/button:border-warning/40 group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut: "border-warning/40 text-warning group-hover/button:border-warning/60",
    icon: "text-warning",
  },
  docs: {
    textColor:
      "text-callout-docs-text/70 dark:text-text-bright transition group-disabled/button:text-text-dimmed/80",
    button:
      "bg-secondary border border-border-bright/50 shadow-xs group-hover/button:bg-background-raised group-disabled/button:bg-tertiary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-blue-500",
  },
  // The AI agent's "Ask Trigger" affordance.
  "ask-trigger": {
    textColor:
      "text-text-bright transition light:group-hover/button:text-charcoal-800 group-disabled/button:text-text-dimmed/80",
    button:
      "cursor-pointer bg-secondary border border-[#41FF54]/25 dark:group-hover/button:bg-background-raised dark:group-hover/button:border-[#41FF54]/40 light:group-hover/button:bg-[#e4ffe8] light:group-hover/button:border-[#41FF54]/60 light:border-success/60 group-disabled/button:bg-secondary group-disabled/button:opacity-60 group-disabled/button:cursor-default group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed dark:group-hover/button:text-text-bright dark:group-hover/button:border-text-dimmed light:group-hover/button:text-charcoal-800 light:group-hover/button:border-charcoal-800/60",
    icon: "text-text-bright light:group-hover/button:text-charcoal-800",
  },
};

type Theme = keyof typeof theme;

function createVariant(sizeName: Size, themeName: Theme) {
  return {
    textColor: theme[themeName].textColor,
    button: cn(sizes[sizeName].button, theme[themeName].button),
    icon: cn(sizes[sizeName].icon, theme[themeName].icon),
    iconSpacing: sizes[sizeName].iconSpacing,
    shortcutVariant: sizes[sizeName].shortcutVariant,
    shortcut: cn(sizes[sizeName].shortcut, theme[themeName].shortcut),
    // Rendered as the leading icon when the caller doesn't pass one.
    defaultLeadingIcon: undefined as RenderIcon | undefined,
  };
}

// ask-trigger supplies its own leading logo. Pass an explicit `LeadingIcon` to animate it.
function createAskTriggerVariant(sizeName: Size, opticalPadding: string, logoSize: number) {
  const base = createVariant(sizeName, "ask-trigger");
  return {
    ...base,
    button: cn(base.button, opticalPadding),
    iconSpacing: "gap-x-1.5",
    defaultLeadingIcon: <AgentMonoLogo size={logoSize} decorative />,
  };
}

const variant = {
  "primary/small": createVariant("small", "primary"),
  "primary/medium": createVariant("medium", "primary"),
  "primary/large": createVariant("large", "primary"),
  "primary/extra-large": createVariant("extra-large", "primary"),
  "secondary/small": createVariant("small", "secondary"),
  "secondary/small-icon": createVariant("small-icon", "secondary"),
  "secondary/medium": createVariant("medium", "secondary"),
  "secondary/large": createVariant("large", "secondary"),
  "secondary/extra-large": createVariant("extra-large", "secondary"),
  "tertiary/small": createVariant("small", "tertiary"),
  "tertiary/medium": createVariant("medium", "tertiary"),
  "tertiary/large": createVariant("large", "tertiary"),
  "tertiary/extra-large": createVariant("extra-large", "tertiary"),
  "minimal/small": createVariant("small", "minimal"),
  "minimal/medium": createVariant("medium", "minimal"),
  "minimal/large": createVariant("large", "minimal"),
  "minimal/extra-large": createVariant("extra-large", "minimal"),
  "danger/small": createVariant("small", "danger"),
  "danger/medium": createVariant("medium", "danger"),
  "danger/large": createVariant("large", "danger"),
  "danger/extra-large": createVariant("extra-large", "danger"),
  "warning/small": createVariant("small", "warning"),
  "warning/medium": createVariant("medium", "warning"),
  "warning/large": createVariant("large", "warning"),
  "warning/extra-large": createVariant("extra-large", "warning"),
  "docs/small": createVariant("small", "docs"),
  "docs/medium": createVariant("medium", "docs"),
  "docs/large": createVariant("large", "docs"),
  "docs/extra-large": createVariant("extra-large", "docs"),
  "ask-trigger/small": createAskTriggerVariant("small", "px-1 pr-1.5", 16),
  "ask-trigger/medium": createAskTriggerVariant("medium", "px-2", 16),
  "ask-trigger/large": createAskTriggerVariant("large", "px-2.5", 20),
  "menu-item": {
    textColor: "text-text-bright px-1",
    button:
      "h-9 px-[0.475rem] text-sm rounded-sm bg-transparent group-hover/button:bg-background-hover",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
    defaultLeadingIcon: undefined,
  },
  "small-menu-item": {
    textColor: "text-text-bright",
    button:
      "h-[1.8rem] px-[0.4rem] text-2sm rounded-sm text-text-dimmed bg-transparent group-hover/button:bg-background-hover",
    icon: "h-[1.125rem]",
    iconSpacing: "gap-x-1.5",
    shortcutVariant: undefined,
    shortcut: undefined,
    defaultLeadingIcon: undefined,
  },
  "small-menu-sub-item": {
    textColor: "text-text-dimmed",
    button:
      "h-[1.8rem] px-2 ml-5 text-2sm rounded-sm text-text-dimmed bg-transparent group-hover/button:bg-background-hover focus-custom",
    icon: undefined,
    iconSpacing: undefined,
    shortcutVariant: undefined,
    shortcut: undefined,
    defaultLeadingIcon: undefined,
  },
};

const allVariants = {
  $all: "cursor-pointer font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus/button:outline-hidden group-disabled/button:opacity-75 group-disabled/button:pointer-events-none focus-custom",
  variant: variant,
};

export type ButtonVariant = keyof typeof variant;

export type ButtonContentPropsType = {
  children?: React.ReactNode;
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  leadingIconClassName?: string;
  fullWidth?: boolean;
  textAlignLeft?: boolean;
  className?: string;
  shortcut?: ShortcutDefinition;
  variant: ButtonVariant;
  shortcutPosition?: "before-trailing-icon" | "after-trailing-icon";
  tooltip?: ReactNode;
  iconSpacing?: string;
  hideShortcutKey?: boolean;
  isLoading?: boolean;
};

export function ButtonContent(props: ButtonContentPropsType) {
  const {
    children: text,
    LeadingIcon,
    TrailingIcon,
    trailingIconClassName,
    leadingIconClassName,
    shortcut,
    fullWidth,
    textAlignLeft,
    className,
    tooltip,
    iconSpacing,
    hideShortcutKey,
    isLoading,
  } = props;

  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), 200);
    return () => clearTimeout(timer);
  }, [isLoading]);

  const variation = allVariants.variant[props.variant];
  // Some variants (ask-trigger) always lead with their own glyph unless overridden.
  const leadingIcon = LeadingIcon ?? variation.defaultLeadingIcon;

  const btnClassName = cn(allVariants.$all, variation.button);
  const iconClassName = variation.icon;
  const iconSpacingClassName = variation.iconSpacing;
  const shortcutClassName = variation.shortcut;
  const textColorClassName = variation.textColor;

  const renderShortcutKey = () =>
    shortcut &&
    !hideShortcutKey && (
      <ShortcutKey
        className={cn(shortcutClassName)}
        shortcut={shortcut}
        variant={variation.shortcutVariant ?? "medium"}
      />
    );

  const buttonContent = (
    <div className={cn("flex", fullWidth ? "" : "w-fit text-xxs", btnClassName, className)}>
      <div className={cn("relative", "flex w-full items-center")}>
        <div
          className={cn(
            textAlignLeft ? "text-left" : "justify-center",
            "flex w-full items-center",
            // The label row owns the variant's text color so children inherit it
            // whatever shape they are. Setting it only on the string branch below
            // left element children (a fragment, a span, text mixed with a value)
            // inheriting the page color instead - near-white on the dark themes,
            // which read as roughly right, but near-black on Light and White.
            textColorClassName,
            iconSpacingClassName,
            iconSpacing,
            showSpinner && "invisible"
          )}
        >
          {leadingIcon && (
            <Icon
              icon={leadingIcon}
              className={cn(
                iconClassName,
                variation.icon,
                leadingIconClassName,
                "shrink-0 justify-start"
              )}
            />
          )}

          {text &&
            (typeof text === "string" ? (
              <span className="mx-auto grow self-center truncate">{text}</span>
            ) : (
              <>{text}</>
            ))}

          {shortcut &&
            !tooltip &&
            props.shortcutPosition === "before-trailing-icon" &&
            renderShortcutKey()}

          {TrailingIcon && (
            <Icon
              icon={TrailingIcon}
              className={cn(
                iconClassName,
                variation.icon,
                trailingIconClassName,
                "shrink-0 justify-end"
              )}
            />
          )}

          {shortcut &&
            !tooltip &&
            (!props.shortcutPosition || props.shortcutPosition === "after-trailing-icon") &&
            renderShortcutKey()}
        </div>
        {showSpinner && (
          // Wears the variant's text color so the spinner tracks the button it's
          // on: white on primary and danger, and dark ink on the neutral
          // variants once the theme is light rather than white on near-white.
          <span
            className={cn("absolute inset-0 flex items-center justify-center", textColorClassName)}
          >
            <Spinner className="size-3.5" color="inherit" />
          </span>
        )}
      </div>
    </div>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{buttonContent}</TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5 py-1.5 pl-2.5 pr-2 text-xs text-text-bright">
            {tooltip} {shortcut && renderShortcutKey()}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return buttonContent;
}

type ButtonPropsType = Pick<
  JSX.IntrinsicElements["button"],
  "type" | "disabled" | "onClick" | "name" | "value" | "form" | "autoFocus" | "aria-label"
> &
  React.ComponentProps<typeof ButtonContent>;

export const Button = forwardRef<HTMLButtonElement, ButtonPropsType>(
  ({ type, disabled, autoFocus, onClick, "aria-label": ariaLabel, ...props }, ref) => {
    const innerRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement);

    const isDisabled = disabled || props.isLoading;

    useShortcutKeys({
      shortcut: props.shortcut,
      action: (e) => {
        if (innerRef.current) {
          innerRef.current.click();
          e.preventDefault();
          e.stopPropagation();
        }
      },
      disabled: isDisabled || !props.shortcut,
    });

    const buttonElement = (
      <button
        className={cn("group/button outline-hidden focus-custom", props.fullWidth ? "w-full" : "")}
        type={type}
        disabled={isDisabled}
        onClick={onClick}
        name={props.name}
        value={props.value}
        ref={innerRef}
        form={props.form}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
      >
        <ButtonContent
          {...props}
          tooltip={undefined}
          hideShortcutKey={props.tooltip ? true : props.hideShortcutKey}
        />
      </button>
    );

    if (props.tooltip) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("flex", isDisabled && "cursor-default")}>{buttonElement}</span>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-1.5 py-1.5 pl-2.5 pr-2 text-xs text-text-bright">
              {props.tooltip}{" "}
              {props.shortcut && !props.hideShortcutKey && (
                <ShortcutKey shortcut={props.shortcut} variant="medium" />
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return buttonElement;
  }
);

type LinkPropsType = Pick<
  LinkProps,
  | "to"
  | "target"
  | "onClick"
  | "onMouseDown"
  | "onMouseEnter"
  | "onMouseLeave"
  | "download"
  | "aria-label"
> & { disabled?: boolean; replace?: boolean } & React.ComponentProps<typeof ButtonContent>;
export const LinkButton = ({
  to,
  onClick,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  download,
  disabled = false,
  replace,
  "aria-label": ariaLabel,
  ...props
}: LinkPropsType) => {
  const innerRef = useRef<HTMLAnchorElement>(null);

  useShortcutKeys({
    shortcut: props.shortcut,
    action: () => {
      if (innerRef.current) {
        innerRef.current.click();
      }
    },
    disabled: disabled || !props.shortcut,
  });

  if (disabled) {
    return (
      <div
        className={cn(
          "group/button pointer-events-none cursor-default opacity-40 outline-hidden",
          props.fullWidth ? "w-full" : ""
        )}
      >
        <ButtonContent {...props} />
      </div>
    );
  }

  if (to.toString().startsWith("http") || to.toString().startsWith("/resources")) {
    return (
      <ExtLink
        href={to.toString()}
        ref={innerRef}
        className={cn("group/button block focus-custom", props.fullWidth ? "w-full" : "")}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        download={download}
        aria-label={ariaLabel}
      >
        <ButtonContent {...props} />
      </ExtLink>
    );
  } else {
    return (
      <Link
        to={to}
        ref={innerRef}
        replace={replace}
        className={cn("group/button block focus-custom", props.fullWidth ? "w-full" : "w-fit")}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        download={download}
        aria-label={ariaLabel}
      >
        <ButtonContent {...props} />
      </Link>
    );
  }
};

type NavLinkPropsType = Pick<NavLinkProps, "to" | "target"> &
  Omit<React.ComponentProps<typeof ButtonContent>, "className"> & {
    className?: (props: { isActive: boolean; isPending: boolean }) => string | undefined;
  };
export const NavLinkButton = ({ to, className, target, ...props }: NavLinkPropsType) => {
  return (
    <NavLink
      to={to}
      className={cn("group/button outline-hidden block", props.fullWidth ? "w-full" : "")}
      target={target}
    >
      {({ isActive, isPending }) => (
        <ButtonContent className={className && className({ isActive, isPending })} {...props} />
      )}
    </NavLink>
  );
};

type ExtLinkProps = JSX.IntrinsicElements["a"] & {
  children: React.ReactNode;
  className?: string;
  href: string;
};

const ExtLink = forwardRef<HTMLAnchorElement, ExtLinkProps>(
  ({ className, href, children, ...props }, ref) => {
    return (
      <a
        className={cn(className)}
        target="_blank"
        rel="noopener noreferrer"
        href={href}
        ref={ref}
        {...props}
      >
        {children}
      </a>
    );
  }
);
