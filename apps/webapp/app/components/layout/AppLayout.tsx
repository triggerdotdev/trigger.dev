import classNames from "classnames";
import { ImpersonationBanner } from "../ImpersonationBanner";

export function AppLayout({
  children,
  impersonationId,
}: {
  children: React.ReactNode;
  impersonationId?: string;
}) {
  if (impersonationId) {
    return (
      <div className="grid h-full w-full grid-rows-[2rem_2rem_3rem_auto_2rem]">
        <ImpersonationBanner impersonationId={impersonationId} />
        {children}
      </div>
    );
  }

  return (
    <div className="grid h-full w-full grid-rows-[2rem_3rem_auto_2rem]">
      {children}
    </div>
  );
}

export function PublicAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-rows-[2rem_auto_auto_2rem]">
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
    <div className={classNames("overflow-y-auto", className)}>{children}</div>
  );
}
