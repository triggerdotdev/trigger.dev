import { InformationCircleIcon } from "@heroicons/react/24/solid";
import { Spinner } from "../primitives/Spinner";
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
  children?: React.ReactNode;
  className?: string;
  message?: string;
}) {
  return (
    <IconPanel
      className={className}
      message={message}
      icon={
        <InformationCircleIcon className="h-6 w-6 min-w-[24px] text-blue-500" />
      }
    >
      {children}
    </IconPanel>
  );
}

export function PanelWarning({
  children,
  className,
  message,
}: {
  children?: React.ReactNode;
  className?: string;
  message?: string;
}) {
  return (
    <IconPanel
      className={className}
      message={message}
      icon={
        <InformationCircleIcon className="h-6 w-6 min-w-[24px] text-yellow-500" />
      }
    >
      {children}
    </IconPanel>
  );
}

export function PanelLoading({
  children,
  className,
  message,
}: {
  children?: React.ReactNode;
  className?: string;
  message?: string;
}) {
  return (
    <IconPanel
      className={className}
      message={message}
      icon={<Spinner className="h-6 w-6 min-w-[24px]" />}
    >
      {children}
    </IconPanel>
  );
}

export function IconPanel({
  children,
  className,
  message,
  icon,
}: {
  children?: React.ReactNode;
  className?: string;
  message?: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className={`flex w-full gap-4 rounded-md border border-slate-600 bg-slate-400/10 py-3 pl-3 pr-4 shadow-md backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-start gap-2.5">
        {icon}
        <Body className="text-slate-300">{message}</Body>
      </div>
      {children}
    </div>
  );
}
