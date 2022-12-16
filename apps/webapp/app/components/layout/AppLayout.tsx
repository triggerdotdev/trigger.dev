import classNames from "classnames";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-rows-[3rem_auto_2rem] w-full h-full">
      {children}
    </div>
  );
}

export function AppBody({
  children,
  className = "bg-slate-950",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("overflow-y-auto", className)}>{children}</div>
  );
}
