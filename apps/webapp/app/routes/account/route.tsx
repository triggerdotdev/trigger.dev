import { Outlet } from "@remix-run/react";
import { AppContainer, MainBody } from "~/components/layout/AppLayout";
import { AccountSideMenu } from "~/components/navigation/AccountSideMenu";
import { useUser } from "~/hooks/useUser";

export default function Page() {
  const user = useUser();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <AccountSideMenu user={user} />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </AppContainer>
  );
}
