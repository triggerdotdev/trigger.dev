import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import type { UseDataFunctionReturn } from "remix-typedjson/dist/remix";
import { Header } from "~/components/Header";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";

export type LoaderData = UseDataFunctionReturn<typeof loader>;

export async function loader({ request }: LoaderArgs) {
  return typedjson(
    {},
    {
      headers: {
        "Set-Cookie": await commitSession(await clearRedirectTo(request)),
      },
    }
  );
}

export default function AppLayout() {
  return (
    <div className="flex h-screen flex-col overflow-auto">
      <Outlet />
    </div>
  );
}
