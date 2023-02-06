import { ExclamationTriangleIcon } from "@heroicons/react/24/solid";
import { Body } from "../primitives/text/Body";

export type PanelWarningProps = {
  children: React.ReactNode;
  className?: string;
};

export function PanelWarning({
  children,
  className,
  message,
}: {
  children?: React.ReactNode;
  className?: string;
  message: string;
}) {
  return (
    <div
      className={`flex w-full items-center rounded-md border border-amber-500 bg-amber-400/10 p-3 shadow-md ${className}`}
    >
      <div className="flex items-center gap-2.5">
        <ExclamationTriangleIcon className="h-6 w-6 min-w-[24px] text-amber-500" />
        <Body className="">{message}</Body>
      </div>
      {children}
    </div>
  );
}
