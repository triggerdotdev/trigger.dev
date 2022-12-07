import { ClipboardIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { CopyText } from "./CopyText";

const variantStyle = {
  slate:
    "bg-slate-600 text-white transition hover:text-slate-700 hover:bg-slate-700 hover:bg-slate-700 hover:text-slate-100 active:bg-slate-800 active:text-slate-300 focus-visible:outline-slate-900",
  blue: "bg-blue-500 transition text-white hover:text-slate-100 hover:bg-blue-600 active:bg-blue-800 active:text-blue-100 focus-visible:outline-blue-600",
  darkTransparent:
    "bg-black/10 text-slate-900 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
  lightTransparent:
    "bg-white/10 text-white-900 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
};

export type CopyTextButtonProps = {
  value: string;
  className?: string;
  variant?: "slate" | "blue" | "darkTransparent" | "lightTransparent";
};

export function CopyTextButton({
  value,
  className,
  variant = "blue",
}: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const onCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }, [setCopied]);
  return (
    <CopyText className={`${className}`} value={value} onCopied={onCopied}>
      {copied ? (
        <div className="flex items-center rounded bg-emerald-200 px-2 py-1 text-slate-600 transition hover:cursor-pointer hover:bg-emerald-200">
          <p className="font-sans text-emerald-700 hover:text-emerald-700">
            Copied!
          </p>
        </div>
      ) : (
        <div
          className={classNames(
            "flex items-center rounded px-2 py-1 hover:cursor-pointer",
            variantStyle[variant]
          )}
        >
          <ClipboardIcon className="mr-[2px] h-4 w-4" />
          <p className="font-sans">Copy</p>
        </div>
      )}
    </CopyText>
  );
}
