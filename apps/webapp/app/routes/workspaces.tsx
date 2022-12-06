import { UserButton } from "@clerk/remix";
import type { LoaderArgs } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import { Header } from "~/components/Header";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request }: LoaderArgs) => {
  const userId = await requireUserId(request);
  return {
    userId,
  };
};

export default function AppLayout() {
  return (
    <div className="flex h-screen flex-col overflow-auto">
      <Header>Workspaces</Header>
      <Outlet />
    </div>
  );
}
