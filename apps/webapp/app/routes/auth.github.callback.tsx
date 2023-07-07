import type { LoaderFunction } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";
import { redirectCookie } from "./auth.github";
import { logger } from "~/services/logger.server";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = redirectValue ?? "/";

  logger.debug("auth.github.callback loader", {
    redirectTo,
  });

  const authuser = await authenticator.authenticate("github", request, {
    successRedirect: redirectTo,
    failureRedirect: "/login",
  });

  logger.debug("auth.github.callback authuser", {
    authuser,
  });

  return authuser;
};
