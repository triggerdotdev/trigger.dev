import { InformationCircleIcon } from "@heroicons/react/24/solid";

export type PanelInfoProps = {
  children: React.ReactNode;
  className?: string;
};

export function PanelInfo({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex gap-2.5 items-center bg-slate-400/10 border border-slate-600 w-full shadow-md rounded-md p-3 ${className}`}
    >
      <InformationCircleIcon className="h-6 w-6 min-w-[24px] text-blue-500" />
      {children}
    </div>
  );
}
