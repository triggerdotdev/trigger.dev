"use client";

import * as React from "react";
import { Header2 } from "./Headers";
import { NamedIcon } from "./NamedIcon";
import { Button } from "./Buttons";
import gradientPath from "./help-gradient.svg";

type HelpContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const HelpContext = React.createContext<HelpContextValue>({
  open: false,
  setOpen: () => {},
});

type HelpProps = {
  defaultOpen?: boolean;
  children?: React.ReactNode;
};

export function Help({ defaultOpen, children }: HelpProps) {
  const [open, setOpen] = React.useState(defaultOpen || false);

  return (
    <HelpContext.Provider value={{ open, setOpen }}>
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { open, setOpen } = React.useContext(HelpContext);

  return (
    <>
      {open && (
        <div className="mb-4 flex flex-col gap-2">
          <div className="flex items-center justify-between pl-1">
            <div className="flex items-center gap-1">
              <NamedIcon name="lightbulb" className="h-4 w-4" />
              <Header2 className="m-0 p-0">{title}</Header2>
            </div>
            <Button
              variant="tertiary/small"
              TrailingIcon="close"
              trailingIconClassName="text-slate-400"
              onClick={() => setOpen(false)}
            >
              Dismiss
            </Button>
          </div>

          <div
            className="rounded border border-slate-850 bg-slate-950 bg-contain bg-left-top bg-no-repeat p-4"
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
