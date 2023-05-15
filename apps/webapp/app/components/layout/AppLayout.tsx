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
    <div
      className={cn(
        "grid h-full w-full grid-rows-[2.75rem_auto] bg-contain bg-right-top bg-no-repeat"
      )}
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
export function MainContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-y-auto px-4 pt-4">
      <div className="pb-4">{children}</div>
    </div>
  );
}
