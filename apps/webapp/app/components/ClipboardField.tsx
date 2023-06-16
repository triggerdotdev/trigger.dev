import { cn } from "~/utils/cn";
import { Button } from "./primitives/Buttons";
import { useCallback, useState } from "react";
import { CheckIcon } from "@heroicons/react/20/solid";

const variations = {
  "primary/small": {
    container:
      "flex text-dimmed font-mono rounded border border-slate-800 bg-slate-850 text-xs ring-offset-background transition hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring",
    input: "bg-slate-850 border-0 text-xs px-2 w-auto rounded-l h-6 leading-6",
    buttonVariant: "primary/small" as const,
    button: "rounded-l-none",
  },
  "secondary/small": {
    container:
      "flex text-dimmed font-mono rounded border border-slate-750 bg-slate-850 text-xs ring-offset-background transition hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring",
    input: "bg-slate-850 border-0 text-xs px-2 w-auto rounded-l h-6 leading-6",
    buttonVariant: "secondary/small" as const,
    button: "rounded-l-none border-l border-slate-750",
  },
  "tertiary/small": {
    container:
      "flex text-dimmed font-mono rounded border border-slate-850 bg-transparent text-xs ring-offset-background transition hover:border-slate-800 hover:bg-slate-950 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring",
    input:
      "bg-transparent border-0 text-xs px-2 w-auto rounded-l h-6 leading-6",
    buttonVariant: "tertiary/small" as const,
    button: "rounded-l-none border-l border-slate-850",
  },
  "primary/medium": {
    container:
      "flex text-dimmed font-mono rounded border border-slate-800 bg-slate-850 text-xs ring-offset-background transition hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring",
    input: "bg-slate-850 border-0 text-xs px-2 w-auto rounded-l h-6 leading-6",
    buttonVariant: "primary/small" as const,
    button: "rounded-l-none",
  },
  "secondary/medium": {
    container:
      "flex text-dimmed font-mono rounded border border-slate-750 bg-slate-850 text-xs ring-offset-background transition hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring",
    input: "bg-slate-850 border-0 text-xs px-2 w-auto rounded-l h-6 leading-6",
    buttonVariant: "secondary/small" as const,
    button: "rounded-l-none border-l border-slate-750",
  },
};

type ClipboardFieldProps = {
  value: string;
  secure?: boolean;
  variant: keyof typeof variations;
  className?: string;
};

export function ClipboardField({
  value,
  secure = false,
  variant,
  className,
}: ClipboardFieldProps) {
  const [isSecure, setIsSecure] = useState(secure);
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

  const { container, input, buttonVariant, button } = variations[variant];

  return (
    <div className={cn(container, className)}>
      <input
        type="text"
        value={isSecure ? "•".repeat(value.length) : value}
        readOnly={true}
        className={cn("select-all", input)}
        size={value.length}
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
      <Button
        variant={buttonVariant}
        onClick={copy}
        className={cn("min-w-[3rem]", button)}
      >
        {copied ? <CheckIcon className="h-4 w-4 text-green-500" /> : "Copy"}
      </Button>
    </div>
  );
}
