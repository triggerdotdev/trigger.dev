import { InformationCircleIcon } from "@heroicons/react/24/solid";
import { Body } from "../primitives/text/Body";

export type PanelInfoProps = {
  children: React.ReactNode;
  className?: string;
};

export function PanelInfo({
  children,
  className,
  message,
}: {
  children: React.ReactNode;
  className?: string;
  message?: string;
}) {
  return (
    <div
      className={`flex w-full justify-between gap-4 rounded-md border border-slate-600 bg-slate-400/10 py-3 pl-3 pr-3 shadow-md ${className}`}
    >
      <div className="flex items-center justify-start gap-2.5">
        <InformationCircleIcon className="h-6 w-6 min-w-[24px] text-blue-500" />
        <Body className="text-slate-300">{message}</Body>
      </div>
      {children}
    </div>
  );
}
