import { cn } from "~/utils/cn";

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
    <div
      className={cn(
        "grid h-full grid-rows-[3.6rem_auto] overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );
}
