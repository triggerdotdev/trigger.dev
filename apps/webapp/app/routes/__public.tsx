import { Outlet } from "@remix-run/react";
import { AppBody, AppLayout } from "~/components/layout/AppLayout";
import { Footer } from "~/components/layout/Footer";
import { NoMobileOverlay } from "~/components/NoMobileOverlay";
import { MarketingHeader } from "~/components/layout/MarketingHeader";

export default function Public() {
  return (
    <AppLayout>
      <NoMobileOverlay />
      <MarketingHeader />
      <AppBody>
        <Outlet />
      </AppBody>
      <Footer />
    </AppLayout>
  );
}
