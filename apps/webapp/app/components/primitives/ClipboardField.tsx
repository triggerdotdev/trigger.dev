import { CheckIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "./Buttons";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";

const variants = {
  "primary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-xs transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "primary/small" as const,
    button: "rounded-l-none",
    iconSize: "h-3 w-3",
    iconPadding: "pl-1",
  },
  "secondary/small": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-xs transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary/small" as const,
    button: "rounded-l-none border-l border-charcoal-750",
    iconSize: "h-3 w-3",
    iconPadding: "pl-1",
  },
  "tertiary/small": {
    container:
      "group/clipboard flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-xs transition duration-150 hover:border-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6 focus:ring-transparent",
    buttonVariant: "minimal/small" as const,
    button:
      "rounded-l-none border-l border-transparent transition group-hover/clipboard:border-charcoal-700",
    iconSize: "h-3 w-3",
    iconPadding: "pl-1",
  },
  "primary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded border bg-charcoal-750 text-sm transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "primary/medium" as const,
    button: "rounded-l-none",
    iconSize: "h-4 w-4",
    iconPadding: "pl-2",
  },
  "secondary/medium": {
    container:
      "flex items-center text-text-dimmed font-mono rounded bg-charcoal-750 text-sm transition hover:bg-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "tertiary/medium" as const,
    button: "rounded-l-none border-l border-charcoal-750",
    iconSize: "h-4 w-4",
    iconPadding: "pl-2",
  },
  "tertiary/medium": {
    container:
      "group flex items-center text-text-dimmed font-mono rounded bg-transparent border border-transparent text-sm transition hover:border-charcoal-700 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-transparent focus:outline-none focus:ring-0 focus:ring-transparent",
    input:
      "bg-transparent border-0 text-sm px-3 w-auto rounded-l h-8 leading-6 focus:ring-transparent",
    buttonVariant: "minimal/medium" as const,
    button: "rounded-l-none border-l border-transparent transition group-hover:border-charcoal-700",
    iconSize: "h-4 w-4",
    iconPadding: "pl-2",
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
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [value]
  );

  useEffect(() => {
    setIsSecure(secure !== undefined && secure);
  }, [secure]);

  const { container, input, buttonVariant, button } = variants[variant];
  const iconClassName = variants[variant].iconSize;
  const iconPosition = variants[variant].iconPadding;
  const inputIcon = useRef<HTMLInputElement>(null);

  return (
    <span className={cn(container, fullWidth ? "w-full" : "max-w-fit", className)}>
      {icon && (
        <span
          onClick={() => inputIcon.current && inputIcon.current.focus()}
          className={cn(iconPosition, "flex items-center")}
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
        // size={value.length}
        // maxLength={3}
        onFocus={(e) => {
          if (secure) {
            setIsSecure((i) => false);
          }
          e.currentTarget.select();
        }}
        onBlur={() => {
          if (secure) {
            setIsSecure((i) => true);
          }
        }}
      />
      {iconButton ? (
        <Button
          variant={buttonVariant}
          onClick={copy}
          className={cn("shrink grow-0 px-1.5", button)}
        >
          {copied ? (
            <ClipboardCheckIcon
              className={cn(
                "h-4 w-4",
                buttonVariant === "primary/small" || buttonVariant === "primary/medium"
                  ? "text-background-dimmed"
                  : "text-green-500"
              )}
            />
          ) : (
            <ClipboardIcon
              className={cn(
                "h-4 w-4",
                buttonVariant === "primary/small" || buttonVariant === "primary/medium"
                  ? "text-background-dimmed"
                  : "text-text-dimmed"
              )}
            />
          )}
        </Button>
      ) : (
        <Button variant={buttonVariant} onClick={copy} className={cn("shrink-0 grow-0", button)}>
          {copied ? <CheckIcon className="mx-[0.4rem] h-4 w-4 text-green-500" /> : "Copy"}
        </Button>
      )}
    </span>
  );
}
