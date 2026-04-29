import { type ReactNode } from "react";
import blurredDashboardBackgroundMenuTop from "~/assets/images/blurred-dashboard-background-menu-top.jpg";
import blurredDashboardBackgroundMenuBottom from "~/assets/images/blurred-dashboard-background-menu-bottom.jpg";
import blurredDashboardBackgroundTable from "~/assets/images/blurred-dashboard-background-table.jpg";

export function BackgroundWrapper({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-background-dimmed lg:bg-transparent">
      <div
        className="absolute left-0 top-0 hidden w-[260px] bg-contain bg-left-top bg-no-repeat lg:block"
        style={{
          backgroundImage: `url(${blurredDashboardBackgroundMenuTop})`,
          aspectRatio: "auto",
          height: "100vh",
          backgroundSize: "260px auto",
        }}
      />

      <div
        className="absolute bottom-0 left-0 hidden w-[260px] bg-contain bg-left-bottom bg-no-repeat lg:block"
        style={{
          backgroundImage: `url(${blurredDashboardBackgroundMenuBottom})`,
          aspectRatio: "auto",
          height: "100vh",
          backgroundSize: "260px auto",
        }}
      />

      <div
        className="absolute top-0 hidden bg-left-top bg-no-repeat lg:block"
        style={{
          left: "260px",
          backgroundImage: `url(${blurredDashboardBackgroundTable})`,
          width: "100%",
          height: "100vh",
          backgroundSize: "1200px auto",
          backgroundColor: "#101214",
        }}
      />

      <div className="relative z-10 h-full w-full">{children}</div>
    </div>
  );
}
