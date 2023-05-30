import { cn } from "~/utils/cn";
import gradientPath from "./app-container-gradient.svg";

/** This container is used to surround the entire app, it correctly places the nav bar */
export function AppContainer({
  children,
  showBackgroundGradient,
}: {
  children: React.ReactNode;
  showBackgroundGradient?: boolean;
}) {
  return (
    <BackgroundGradient showBackgroundGradient={showBackgroundGradient}>
      <div className={cn("grid h-full w-full grid-rows-[2.75rem_auto]")}>
        {children}
      </div>
    </BackgroundGradient>
  );
}

export function BackgroundGradient({
  children,
  showBackgroundGradient,
}: {
  children: React.ReactNode;
  showBackgroundGradient?: boolean;
}) {
  return (
    <div
      className={cn("h-full w-full bg-contain bg-right-top bg-no-repeat")}
      style={
        showBackgroundGradient
          ? {
              backgroundImage: `url(${gradientPath})`,
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/** This container should be placed around the content on a page */
export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn("grid h-full grid-rows-[auto_1fr]")}>{children}</div>
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
      className={cn(scrollable ? "overflow-y-auto p-4 " : "overflow-hidden")}
    >
      {children}
    </div>
  );
}

export function MainCenteredContainer({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-full w-full">
      <div className="mx-auto mt-[30vh] max-w-xs">{children}</div>
    </div>
  );
}
