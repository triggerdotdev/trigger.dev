import { useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { CopyButton } from "./CopyButton";

const variants = {
  "primary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-background-hover text-xs transition hover:bg-background-raised focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "primary" as const,
    size: "small" as const,
    button: "rounded-l-none",
  },
  "secondary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-background-hover text-xs transition hover:bg-background-raised focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary" as const,
    size: "small" as const,
    button: "rounded-l-none border-l border-grid-dimmed",
  },
  "tertiary/small": {
    container:
      "group/clipboard flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-xs transition duration-150 hover:border-grid-bright focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "minimal" as const,
    size: "small" as const,
    button:
      "rounded-l-none border-l border-transparent transition group-hover/clipboard:border-grid-bright",
  },
  "primary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-background-hover text-sm transition hover:bg-background-raised focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "primary" as const,
    size: "medium" as const,
    button: "rounded-l-none",
  },
  "secondary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded bg-background-hover text-sm transition hover:bg-background-raised focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary" as const,
    size: "medium" as const,
    button: "rounded-l-none border-l border-grid-dimmed",
  },
  "tertiary/medium": {
    container:
      "group flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-sm transition hover:border-grid-bright focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "minimal" as const,
    size: "medium" as const,
    button: "rounded-l-none border-l border-transparent transition group-hover:border-grid-bright",
  },
};

const SECURE_MASK = "••••••••••••••••";

/**
 * Builds the masked display string, optionally revealing the first/last few
 * characters in cleartext so users can confirm a copied value. A custom mask
 * string (when `secure` is a string) is always shown as-is.
 */
function maskValue(
  value: string,
  secure: boolean | string,
  revealStart: number,
  revealEnd: number
) {
  if (typeof secure === "string") {
    return secure;
  }

  const start = Math.max(0, revealStart);
  const end = Math.max(0, revealEnd);

  // Nothing to reveal, or revealing would leak the whole value: fully mask.
  if ((start === 0 && end === 0) || start + end >= value.length) {
    return SECURE_MASK;
  }

  const revealedStart = start > 0 ? value.slice(0, start) : "";
  const revealedEnd = end > 0 ? value.slice(-end) : "";
  return `${revealedStart}${SECURE_MASK}${revealedEnd}`;
}

type ClipboardFieldProps = {
  value: string;
  secure?: boolean | string;
  /** When masked, reveal this many of the first characters in cleartext. */
  secureRevealStart?: number;
  /** When masked, reveal this many of the last characters in cleartext. */
  secureRevealEnd?: number;
  variant: keyof typeof variants;
  className?: string;
  icon?: React.ReactNode;
  iconButton?: boolean;
  fullWidth?: boolean;
};

export function ClipboardField({
  value,
  secure = false,
  secureRevealStart = 0,
  secureRevealEnd = 0,
  variant,
  className,
  icon,
  iconButton = false,
  fullWidth = true,
}: ClipboardFieldProps) {
  const [isSecure, setIsSecure] = useState(secure !== undefined && secure);
  const inputIcon = useRef<HTMLInputElement>(null);
  const { container, input, buttonVariant, button, size } = variants[variant];

  useEffect(() => {
    setIsSecure(secure !== undefined && secure);
  }, [secure]);

  const maskedValue = maskValue(value, secure, secureRevealStart, secureRevealEnd);

  return (
    <span className={cn(container, fullWidth ? "w-full" : "max-w-fit", className)}>
      {icon && (
        <span
          onClick={() => inputIcon.current && inputIcon.current.focus()}
          className="flex items-center pl-1"
        >
          {icon}
        </span>
      )}
      <input
        type="text"
        ref={inputIcon}
        value={isSecure ? maskedValue : value}
        readOnly={true}
        className={cn(
          "shrink grow select-all overflow-x-auto",
          fullWidth ? "w-full" : "max-w-fit",
          input
        )}
        onFocus={(e) => {
          if (secure) {
            setIsSecure(false);
          }
          e.currentTarget.select();
        }}
        onBlur={() => {
          if (secure) {
            setIsSecure(true);
          }
        }}
      />
      <CopyButton
        value={value}
        variant={iconButton ? "icon" : "button"}
        buttonVariant={buttonVariant}
        size={size}
        buttonClassName={button}
        showTooltip={false}
      />
    </span>
  );
}
