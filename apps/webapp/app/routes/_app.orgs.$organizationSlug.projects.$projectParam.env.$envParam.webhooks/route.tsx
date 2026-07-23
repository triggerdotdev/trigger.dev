import { Outlet } from "@remix-run/react";
import { PageContainer } from "~/components/layout/AppLayout";

export default function Page() {
  return (
    <PageContainer>
      <Outlet />
    </PageContainer>
  );
}
