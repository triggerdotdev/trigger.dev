import { cn } from "~/utils/cn";

/** This container is used to surround the entire app, it correctly places the nav bar */
export function AppContainer({ children }: { children: React.ReactNode }) {
  return <div className={cn("grid h-full w-full grid-rows-1 overflow-hidden")}>{children}</div>;
}

/** This container should be placed around the content on a page */
export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid h-full grid-rows-[auto_1fr] overflow-hidden", className)}>
      {children}
    </div>
  );
}

export function PageBody({
  children,
  scrollable = true,
}: {
  children: React.ReactNode;
  scrollable?: boolean;
}) {
  return (
    <div
      className={cn(
        scrollable
          ? "overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          : "overflow-hidden"
      )}
    >
      {children}
    </div>
  );
}

export function PageBodyPadding({ children }: { children: React.ReactNode }) {
  return <div className="p-4">{children}</div>;
}

export function MainCenteredContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <div className={cn("mx-auto mt-[25vh] max-w-xs overflow-y-auto", className)}>{children}</div>
    </div>
  );
}
