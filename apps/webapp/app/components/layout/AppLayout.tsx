import classNames from "classnames";

export function AppLayoutThreeCol({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-cols-[3.5rem_auto]">{children}</div>
  );
}

export function AppLayoutTwoCol({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-cols-[16rem_auto] overflow-hidden">
      {children}
    </div>
  );
}

export function AppBody({
  children,
  className = "bg-slate-850",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("h-full overflow-y-auto", className)}>
      {children}
    </div>
  );
}

export function PublicAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-rows-[4rem_auto] overflow-y-auto">
      {children}
    </div>
  );
}

export function LoggedInAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-rows-[2rem_auto] overflow-y-auto">
      {children}
    </div>
  );
}

export function PublicAppBody({
  children,
  className = "bg-slate-850",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={classNames("", className)}>{children}</div>;
}
