import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  AppBody,
  AppLayout,
  PublicAppLayout,
} from "~/components/layout/AppLayout";
import { Footer } from "~/components/layout/Footer";
import { Header } from "~/components/layout/Header";
import { MarketingHeader } from "~/components/layout/MarketingHeader";
import { ProductHuntBanner } from "~/components/ProductHuntBanner";
import { getOrganizations } from "~/models/organization.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getUserId } from "~/services/session.server";

export const loader = async ({ request }: LoaderArgs) => {
  const userId = await getUserId(request);

  if (!userId) {
    return typedjson({
      userId: undefined,
      organizations: [],
      impersonationId: undefined,
    });
  }

  const organizations = await getOrganizations({ userId });
  const impersonationId = await getImpersonationId(request);

  return typedjson({
    userId,
    organizations,
    impersonationId,
  });
};

export default function Public() {
  const loaderData = useTypedLoaderData<typeof loader>();

  const LayoutComponent = loaderData.userId ? AppLayout : PublicAppLayout;

  return (
    <LayoutComponent>
      <ProductHuntBanner />
      {loaderData.userId ? <Header /> : <MarketingHeader />}
      <AppBody>
        <Outlet />
      </AppBody>
      <Footer />
    </LayoutComponent>
  );
}
