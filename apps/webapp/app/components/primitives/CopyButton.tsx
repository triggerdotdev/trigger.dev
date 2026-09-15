import { CheckIcon } from "@heroicons/react/20/solid";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/utils/cn";
import { Button, type ButtonVariant } from "./Buttons";
import { SimpleTooltip } from "./Tooltip";

const sizes = {
  "extra-small": {
    icon: "size-3",
    button: "h-5 px-1",
  },
  small: {
    icon: "size-3.5",
    button: "h-6 px-1",
  },
  medium: {
    icon: "size-4",
    button: "h-8 px-1.5",
  },
};

type CopyButtonProps = {
  value: string;
  variant?: "icon" | "button";
  size?: keyof typeof sizes;
  className?: string;
  buttonClassName?: string;
  showTooltip?: boolean;
  buttonVariant?: "primary" | "secondary" | "tertiary" | "minimal";
  children?: React.ReactNode;
};

export function CopyButton({
  value,
  variant = "button",
  size = "medium",
  className,
  buttonClassName,
  showTooltip = true,
  buttonVariant = "tertiary",
  children,
}: CopyButtonProps) {
  const { copy, copied } = useCopy(value);

  const { icon: iconSize, button: buttonSize } = sizes[size];

  if (variant === "button") {
    return (
      <span className={className}>
        <Button
          variant={`${buttonVariant}/${size === "extra-small" ? "small" : size}`}
          onClick={copy}
          className={cn("shrink-0", buttonClassName)}
          tooltip={showTooltip ? (copied ? "Copied!" : "Copy") : undefined}
          aria-label={children ? undefined : copied ? "Copied" : "Copy"}
          LeadingIcon={
            copied ? (
              <ClipboardCheckIcon
                className={cn(
                  iconSize,
                  buttonVariant === "primary" ? "text-background-dimmed" : "text-green-500"
                )}
              />
            ) : (
              <ClipboardIcon
                className={cn(
                  iconSize,
                  buttonVariant === "primary" ? "text-background-dimmed" : "text-text-dimmed"
                )}
              />
            )
          }
        >
          {children}
        </Button>
      </span>
    );
  }

  const iconButton = (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={copy}
      className={cn(
        buttonSize,
        "flex shrink-0 items-center justify-center rounded border border-border-bright bg-background-hover",
        copied
          ? "text-green-500"
          : "text-text-dimmed hover:border-border-bright hover:bg-background-raised hover:text-text-bright",
        buttonClassName
      )}
    >
      {copied ? (
        <ClipboardCheckIcon className={iconSize} />
      ) : (
        <ClipboardIcon className={iconSize} />
      )}
    </button>
  );

  if (!showTooltip) return <span className={className}>{iconButton}</span>;

  return (
    <span className={className}>
      <SimpleTooltip
        // The icon button is a real <button>; without asChild the tooltip
        // trigger wraps it in its own, and the browser parser splits the nested
        // buttons apart, which React then fails to hydrate.
        asChild
        tabbable
        button={iconButton}
        content={copied ? "Copied!" : "Copy"}
        className="font-sans"
        disableHoverableContent
      />
    </span>
  );
}

/**
 * Copies a ready-to-paste AI agent prompt, briefly swapping its label to confirm.
 *
 * The prompt is built by the caller — it is long, page-specific text, not a value
 * a user would ever want echoed in a tooltip, so this stays a plain button rather
 * than reusing the `CopyButton` clipboard treatment above.
 */
export function CopyAgentPromptButton({
  prompt,
  label,
  tooltip,
  variant = "primary/medium",
}: {
  prompt: string;
  /** Idle label. Keep it at least as long as "Copied prompt" — its width is reserved for it. */
  label: string;
  tooltip: string;
  variant?: ButtonVariant;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    []
  );

  const onCopy = async () => {
    try {
      // Throws when the clipboard API is unavailable (e.g. an insecure context) and
      // rejects when the write is denied. Either way the prompt was not copied, so
      // fall through without confirming it.
      await navigator.clipboard.writeText(prompt);
    } catch {
      return;
    }

    if (unmountedRef.current) return;

    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <Button type="button" variant={variant} onClick={() => void onCopy()}>
          <span className="grid justify-items-center">
            <span className="col-start-1 row-start-1 flex items-center gap-x-1.5">
              {copied && <CheckIcon className="size-4 shrink-0 text-text-bright" />}
              <span>{copied ? "Copied prompt" : label}</span>
            </span>
            {/* The idle label is the longest, so reserve its width to stop the button from
                resizing when it briefly swaps to the shorter "Copied prompt". */}
            <span aria-hidden className="invisible col-start-1 row-start-1">
              {label}
            </span>
          </span>
        </Button>
      }
      content={tooltip}
    />
  );
}
