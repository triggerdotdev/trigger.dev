import { type ReactNode } from "react";
import blurredDashboardBackground from "~/assets/images/blurred-dashboard-background.jpg";

export function BackgroundWrapper({ children }: { children: ReactNode }) {
  return (
    <div
      className="h-full w-full bg-cover bg-left-top bg-no-repeat"
      style={{
        backgroundImage: `url(${blurredDashboardBackground})`,
      }}
    >
      {children}
    </div>
  );
}
