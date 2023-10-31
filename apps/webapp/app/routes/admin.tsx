import { HomeIcon } from "@heroicons/react/24/outline";
import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { getUser, requireUserId } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const user = await getUser(request);
  if (user == null) {
    return redirect("/");
  }

  if (!user.admin) {
    return redirect("/");
  }

  return typedjson({ user });
}

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <div className="h-full w-full">
      <Outlet />
    </div>
  );
}
