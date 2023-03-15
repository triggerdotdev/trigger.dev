import React, { memo } from "react";

export type TooltipProps = {
  children: React.ReactNode;
  text: string;
};

export const MenuTitleToolTip: React.FC<TooltipProps> = memo((props) => {
  return (
    <span className="group relative flex">
      <span className="pointer-events-none absolute top-0.5 left-12 flex translate-x-0 items-center justify-center whitespace-nowrap rounded bg-slate-700 px-3 py-2 text-sm text-slate-300 opacity-0 shadow transition before:absolute before:-left-2 before:top-full before:-translate-y-[22px] before:border-4 before:border-transparent before:border-r-slate-700 before:shadow before:content-[''] group-hover:opacity-100">
        {props.text}
      </span>
      {props.children}
    </span>
  );
});

MenuTitleToolTip.displayName = "Menu Title";
