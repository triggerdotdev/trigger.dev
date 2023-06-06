"use client";

import * as React from "react";
import { Header2 } from "./Headers";
import { NamedIcon } from "./NamedIcon";
import { Button } from "./Buttons";
import gradientPath from "./help-gradient.svg";
import { cn } from "~/utils/cn";

type HelpContextValue = {
  open: boolean;
  allowDismissing: boolean;
  setOpen: (open: boolean) => void;
};

const HelpContext = React.createContext<HelpContextValue>({
  open: false,
  setOpen: () => {},
  allowDismissing: true,
});

type HelpProps = {
  defaultOpen?: boolean;
  allowDismissing?: boolean;
  children?: React.ReactNode;
};

export function Help({
  defaultOpen,
  allowDismissing = true,
  children,
}: HelpProps) {
  const [open, setOpen] = React.useState(defaultOpen || false);

  return (
    <HelpContext.Provider value={{ open, setOpen, allowDismissing }}>
      {children}
    </HelpContext.Provider>
  );
}

export function HelpTrigger({ title }: { title: string }) {
  const { open, setOpen } = React.useContext(HelpContext);

  return open ? (
    <></>
  ) : (
    <Button
      variant="tertiary/small"
      LeadingIcon="lightbulb"
      leadingIconClassName="text-slate-400"
      onClick={() => setOpen(true)}
    >
      {title}
    </Button>
  );
}

export function HelpContent({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { open, setOpen, allowDismissing } = React.useContext(HelpContext);

  return (
    <>
      {open && (
        <div className={cn("mb-4 flex grow flex-col gap-2", className)}>
          <div className="flex items-center justify-between pl-1">
            <div className="flex items-center gap-1">
              <NamedIcon name="lightbulb" className="h-4 w-4" />
              <Header2 className="m-0 p-0">{title}</Header2>
            </div>
            {allowDismissing && (
              <Button
                variant="tertiary/small"
                TrailingIcon="close"
                trailingIconClassName="text-slate-400"
                onClick={() => setOpen(false)}
              >
                Dismiss
              </Button>
            )}
          </div>

          <div
            className="grow rounded border border-slate-850 bg-midnight-850 bg-contain bg-left-top bg-no-repeat p-4"
            style={{
              backgroundImage: `url(${gradientPath})`,
            }}
          >
            {children}
          </div>
        </div>
      )}
    </>
  );
}
