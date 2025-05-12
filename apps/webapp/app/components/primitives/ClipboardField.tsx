import { useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { CopyButton } from "./CopyButton";

const variants = {
  "primary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-xs transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "primary" as const,
    size: "small" as const,
    button: "rounded-l-none",
  },
  "secondary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-xs transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary" as const,
    size: "small" as const,
    button: "rounded-l-none border-l border-charcoal-750",
  },
  "tertiary/small": {
    container:
      "group/clipboard flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-xs transition duration-150 hover:border-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "minimal" as const,
    size: "small" as const,
    button:
      "rounded-l-none border-l border-transparent transition group-hover/clipboard:border-charcoal-700",
  },
  "primary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-sm transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "primary" as const,
    size: "medium" as const,
    button: "rounded-l-none",
  },
  "secondary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded bg-charcoal-750 text-sm transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary" as const,
    size: "medium" as const,
    button: "rounded-l-none border-l border-charcoal-750",
  },
  "tertiary/medium": {
    container:
      "group flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-sm transition hover:border-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "minimal" as const,
    size: "medium" as const,
    button: "rounded-l-none border-l border-transparent transition group-hover:border-charcoal-700",
  },
};

type ClipboardFieldProps = {
  value: string;
  secure?: boolean | string;
  variant: keyof typeof variants;
  className?: string;
  icon?: React.ReactNode;
  iconButton?: boolean;
  fullWidth?: boolean;
};

export function ClipboardField({
  value,
  secure = false,
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
        value={isSecure ? (typeof secure === "string" ? secure : "••••••••••••••••") : value}
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
