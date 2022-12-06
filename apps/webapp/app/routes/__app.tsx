import {
  AuthProvider,
  RedirectToLogin,
  RequiredAuthProvider,
} from "@propelauth/react";
import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { env } from "../env.server";
import { typedjson } from "remix-typedjson";
import { useTypedLoaderData } from "remix-typedjson/dist/remix";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";

export const loader = async ({ request }: LoaderArgs) => {
  return typedjson(
    { authUrl: env.AUTH_URL },
    {
      headers: {
        "Set-Cookie": await commitSession(await clearRedirectTo(request)),
      },
    }
  );
};

export default function AppLayout() {
  const { authUrl } = useTypedLoaderData<typeof loader>();

  return (
    <AuthProvider authUrl={authUrl}>
      <div className="flex h-screen flex-col overflow-auto">
        <Outlet />
      </div>
    </AuthProvider>
  );
}
