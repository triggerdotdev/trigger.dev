import { ExclamationTriangleIcon } from "@heroicons/react/24/solid";

export type PanelWarningProps = {
  children: React.ReactNode;
  className?: string;
};

export function PanelWarning({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex gap-2.5 items-center bg-amber-400/10 border border-amber-500 w-full shadow-md rounded-md p-3 ${className}`}
    >
      <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
      {children}
    </div>
  );
}
