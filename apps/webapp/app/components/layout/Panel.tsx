export type PanelProps = {
  children: React.ReactNode;
  className?: string;
};

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-slate-800 w-full shadow-md rounded-md px-3 pt-3 pb-1 ${className}`}
    >
      {children}
    </div>
  );
}
