import { ClipboardIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { CopyText } from "./CopyText";

const variantStyle = {
  slate:
    "bg-slate-800 text-white rounded px-2 py-1 transition hover:text-slate-700 hover:bg-slate-700 hover:bg-slate-700 hover:text-slate-100 active:bg-slate-800 active:text-slate-300 focus-visible:outline-slate-900",
  blue: "bg-indigo-600 rounded px-2 py-1 transition text-white hover:bg-indigo-500 active:bg-indigo-800 active:text-indigo-100 focus-visible:outline-indigo-600",
  darkTransparent:
    "bg-black/10 text-slate-900 rounded px-2 py-1 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
  lightTransparent:
    "bg-white/10 text-white-900 rounded px-2 py-1 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
  text: "text-sm text-slate-300 transition hover:text-slate-400",
};

export type CopyTextButtonProps = {
  value: string;
  className?: string;
  variant?: "slate" | "blue" | "darkTransparent" | "lightTransparent" | "text";
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
        <div
          className={classNames(
            "flex items-center  hover:cursor-pointer",
            variantStyle[variant]
          )}
        >
          <p className="font-sans">Copied!</p>
        </div>
      ) : (
        <div
          className={classNames(
            "flex items-center  hover:cursor-pointer",
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
