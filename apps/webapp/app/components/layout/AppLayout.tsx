import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { useShowUpgradePrompt } from "../billing/v2/UpgradePrompt";

/** This container is used to surround the entire app, it correctly places the nav bar */
export function AppContainer({ children }: { children: React.ReactNode }) {
  return <div className={cn("grid h-full w-full grid-rows-1 overflow-hidden")}>{children}</div>;
}

export function MainBody({ children }: { children: React.ReactNode }) {
  return <div className={cn("grid grid-rows-1 overflow-hidden")}>{children}</div>;
}

/** This container should be placed around the content on a page */
export function PageContainer({ children }: { children: React.ReactNode }) {
  const organization = useOptionalOrganization();
  const showUpgradePrompt = useShowUpgradePrompt(organization);

  return (
    <div
      className={cn(
        "grid overflow-hidden",
        showUpgradePrompt.shouldShow ? "grid-rows-[5rem_1fr]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      {children}
    </div>
  );
}

export function PageBody({
  children,
  scrollable = true,
  className,
}: {
  children: React.ReactNode;
  scrollable?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        scrollable
          ? "overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          : "overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );
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
      <div className={cn("mx-auto mt-6 max-w-xs overflow-y-auto p-1 md:mt-[22vh]", className)}>
        {children}
      </div>
    </div>
  );
}
