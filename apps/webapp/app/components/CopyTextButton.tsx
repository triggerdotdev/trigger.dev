import {
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { EnvironmentIcon } from "~/routes/resources/environment";
import { CopyText } from "./CopyText";
import { TertiaryButton } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { Tooltip } from "./primitives/Tooltip";

const variantStyle = {
  slate:
    "bg-slate-800 text-white rounded px-2 py-1 transition hover:text-slate-700 hover:bg-slate-700 hover:bg-slate-700 hover:text-slate-100 active:bg-slate-800 active:text-slate-300 focus-visible:outline-slate-900",
  blue: "text-sm bg-indigo-700 rounded px-3 py-2 transition text-white hover:bg-indigo-600 active:bg-indigo-800 active:text-indigo-100 focus-visible:outline-indigo-600",
  darkTransparent:
    "bg-black/10 text-slate-900 rounded px-2 py-1 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
  lightTransparent:
    "bg-white/10 text-white-900 rounded px-2 py-1 transition hover:bg-blue-50 active:bg-blue-200 active:text-slate-600 focus-visible:outline-white",
  text: "text-sm text-slate-400 transition hover:text-slate-300",
};

export type CopyTextButtonProps = {
  value: string;
  text?: string;
  className?: string;
  variant?: "slate" | "blue" | "darkTransparent" | "lightTransparent" | "text";
};

export function CopyTextButton({
  value,
  className,
  text,
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
            "flex items-center hover:cursor-pointer",
            variantStyle[variant]
          )}
        >
          <p className="font-sans">Copied!</p>
        </div>
      ) : (
        <div
          className={classNames(
            "flex items-center hover:cursor-pointer",
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

const panelVariantStyle = {
  primary:
    "truncate text-indigo-100 bg-indigo-700/50 pl-3.5 pr-2 py-3 rounded border border-indigo-600 flex items-center justify-between gap-2 hover:cursor-pointer hover:bg-indigo-600/50 hover:border-indigo-600 transition",
  slate:
    "flex w-full items-center justify-between gap-2 truncate rounded bg-slate-850 py-2 pl-2.5 pr-1 transition hover:cursor-pointer hover:bg-slate-850/70 hover:text-slate-300",
  text: "flex w-full items-center justify-between gap-2 truncate rounded bg-transparent py-2 pl-2.5 pr-1 transition hover:cursor-pointer hover:border-slate-700/50 hover:bg-slate-700/50",
};

export type CopyTextPanelProps = {
  value: string;
  text?: string;
  className?: string;
  variant?: "primary" | "slate" | "text";
};

export function CopyTextPanel({
  value,
  text,
  className,
  variant = "primary",
}: CopyTextPanelProps) {
  const [copied, setCopied] = useState(false);
  const onCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }, [setCopied]);
  return (
    <CopyText value={value} onCopied={onCopied} className="w-full">
      {copied ? (
        <div className={classNames(className, panelVariantStyle[variant])}>
          <span className="truncate font-mono text-sm">{text ?? value}</span>
          <CheckIcon className="h-5 w-5 min-w-[1.25rem] text-green-500" />
        </div>
      ) : (
        <div className={classNames(className, panelVariantStyle[variant])}>
          <span className="truncate font-mono text-sm">{text ?? value}</span>
          <ClipboardIcon className="h-4 w-4 min-w-[1.25rem]" />
        </div>
      )}
    </CopyText>
  );
}

export type CopyTextSideMenuProps = {
  value: string;
  text?: string;
};

export function CopyTextSideMenu({ value, text }: CopyTextPanelProps) {
  const [copied, setCopied] = useState(false);
  const [isShowingKeys, setIsShowingKeys] = useState(false);
  const onCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }, [setCopied]);
  return (
    <CopyText value={value} onCopied={onCopied} className="w-full">
      {copied ? (
        <div className={classNames(copyTextSideMenuStyles)}>
          {isShowingKeys === true ? (
            <Body className="truncate font-mono text-sm">{text ?? value}</Body>
          ) : (
            <div className="flex items-center gap-2 truncate">
              <KeyIcon className="h-6 w-6 min-w-[1.5rem]" />
              <Body className="truncate">{text ?? value}</Body>
            </div>
          )}
          <div className="flex items-center gap-1">
            <div className="flex items-center rounded p-1.5 opacity-0 transition hover:bg-slate-800 group-hover:opacity-100">
              {!isShowingKeys ? (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(true)}
                  className="group transition"
                >
                  <EyeIcon className="h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                </TertiaryButton>
              ) : (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(false)}
                  className="group transition"
                >
                  <EyeSlashIcon className="h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                </TertiaryButton>
              )}
            </div>
            <CheckIcon className="h-4 w-4 text-green-500" />
          </div>
        </div>
      ) : (
        <div className={classNames(copyTextSideMenuStyles)}>
          <div className="flex items-center gap-2 truncate">
            <KeyIcon className="h-6 w-6 min-w-[1.5rem]" />
            <Body className="truncate">{text ?? value}</Body>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex items-center rounded p-1.5 opacity-0 transition hover:bg-slate-800 group-hover:opacity-100">
              {!isShowingKeys ? (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(true)}
                  className="group transition"
                >
                  <EyeIcon className="h-4 w-4 text-slate-400 transition group-hover:text-slate-300" />
                </TertiaryButton>
              ) : (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(false)}
                  className="group transition"
                >
                  <EyeSlashIcon className="h-4 w-4 text-slate-400 transition group-hover:text-slate-300" />
                </TertiaryButton>
              )}
            </div>
            <ClipboardIcon className="h-4 w-4" />
          </div>
        </div>
      )}
    </CopyText>
  );
}

const copyTextSideMenuStyles =
  "group flex w-full items-center text-slate-300 justify-between truncate rounded py-1.5 pl-3 pr-2.5 transition hover:cursor-pointer hover:bg-slate-850";
