import { Outlet } from "@remix-run/react";
import { AppContainer } from "~/components/layout/AppLayout";
import { AccountSideMenu } from "~/components/navigation/AccountSideMenu";
import { Breadcrumb } from "~/components/navigation/Breadcrumb";
import { PageNavigationIndicator } from "~/components/navigation/PageNavigationIndicator";
import { useUser } from "~/hooks/useUser";

export default function Page() {
  const user = useUser();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <AccountSideMenu user={user} />

        <div className="grid grid-rows-[2.25rem_1fr] overflow-hidden">
          <div className="flex w-full items-center justify-between border-b border-grid-bright">
            <Breadcrumb />
            <div className="flex h-full items-center gap-4">
              <PageNavigationIndicator className="mr-2" />
            </div>
          </div>
          <Outlet />
        </div>
      </div>
    </AppContainer>
  );
}
