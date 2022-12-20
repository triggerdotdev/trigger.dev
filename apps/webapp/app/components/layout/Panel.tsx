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
      className={`bg-slate-800 w-full shadow-md rounded-md p-3 ${className}`}
    >
      {children}
    </div>
  );
}
