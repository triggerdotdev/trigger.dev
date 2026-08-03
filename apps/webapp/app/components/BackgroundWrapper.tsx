import { type ReactNode } from "react";
import blurredDashboardBackgroundMenuTop from "~/assets/images/blurred-dashboard-background-menu-top.jpg";
import blurredDashboardBackgroundMenuTopLight from "~/assets/images/blurred-dashboard-background-menu-top-light.jpg";
import blurredDashboardBackgroundMenuBottom from "~/assets/images/blurred-dashboard-background-menu-bottom.jpg";
import blurredDashboardBackgroundMenuBottomLight from "~/assets/images/blurred-dashboard-background-menu-bottom-light.jpg";
import blurredDashboardBackgroundTable from "~/assets/images/blurred-dashboard-background-table.jpg";
import blurredDashboardBackgroundTableLight from "~/assets/images/blurred-dashboard-background-table-light.jpg";

/* Blurred dashboard screenshots; the -light set is the same artwork with the
   lightness inverted for the light theme. */
const BACKDROPS = [
  {
    images: {
      menuTop: blurredDashboardBackgroundMenuTop,
      menuBottom: blurredDashboardBackgroundMenuBottom,
      table: blurredDashboardBackgroundTable,
    },
    tableFill: "#101214",
    /* `light` is a zero-specificity variant, so `light:lg:hidden` ties with
       `lg:block` - the `!` guarantees the dark backdrop loses on Light. */
    className: "hidden lg:block light:lg:hidden!",
  },
  {
    images: {
      menuTop: blurredDashboardBackgroundMenuTopLight,
      menuBottom: blurredDashboardBackgroundMenuBottomLight,
      table: blurredDashboardBackgroundTableLight,
    },
    tableFill: "#f4f5f7",
    className: "hidden light:lg:block",
  },
];

export function BackgroundWrapper({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-background-dimmed lg:bg-transparent">
      {BACKDROPS.map(({ images, tableFill, className }) => (
        <div key={tableFill} className={className}>
          <div
            className="absolute left-0 top-0 w-[260px] bg-contain bg-top-left bg-no-repeat"
            style={{
              backgroundImage: `url(${images.menuTop})`,
              aspectRatio: "auto",
              height: "100vh",
              backgroundSize: "260px auto",
            }}
          />

          <div
            className="absolute bottom-0 left-0 w-[260px] bg-contain bg-bottom-left bg-no-repeat"
            style={{
              backgroundImage: `url(${images.menuBottom})`,
              aspectRatio: "auto",
              height: "100vh",
              backgroundSize: "260px auto",
            }}
          />

          <div
            className="absolute top-0 bg-top-left bg-no-repeat"
            style={{
              left: "260px",
              backgroundImage: `url(${images.table})`,
              width: "100%",
              height: "100vh",
              backgroundSize: "1200px auto",
              backgroundColor: tableFill,
            }}
          />
        </div>
      ))}

      <div className="relative z-10 h-full w-full">{children}</div>
    </div>
  );
}
