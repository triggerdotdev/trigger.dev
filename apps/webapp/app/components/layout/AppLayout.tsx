import { cn } from "~/utils/cn";

/** This container is used to surround the entire app, it correctly places the nav bar */
export function AppContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full grid-rows-[2.75rem_auto]">
      {children}
    </div>
  );
}

/** This container should be placed around the content on a page */
export function MainContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-y-auto px-4 pt-4">
      <div className="pb-4">{children}</div>
    </div>
  );
}

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
