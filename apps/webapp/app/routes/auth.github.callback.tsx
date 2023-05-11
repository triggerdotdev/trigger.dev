import type { LoaderFunction } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";
import { redirectCookie } from "./auth.github";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = redirectValue ?? "/";

  const authuser = await authenticator.authenticate("github", request, {
    successRedirect: redirectTo,
    failureRedirect: "/login",
  });

  return authuser;
};
