import { Outlet, useMatches } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import type { UseDataFunctionReturn } from "remix-typedjson/dist/remix";
import { Footer, Header } from "~/libraries/ui";
import WorkspaceMenu from "~/libraries/ui/src/components/WorkspaceMenu";
import { getWorkspaces } from "~/models/workspace.server";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUserId } from "~/services/session.server";

export type LoaderData = UseDataFunctionReturn<typeof loader>;

export async function loader({ request }: LoaderArgs) {
  return typedjson(
    {  },
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
      <header>
        <h1>Root</h1>
      </header>
      <Outlet />
    </div>
  );
}
