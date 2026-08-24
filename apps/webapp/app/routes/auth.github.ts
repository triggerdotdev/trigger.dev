import { type ActionFunction, type LoaderFunction, redirect } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";
import { githubRedirectCookie } from "~/services/redirectCookies.server";
import { sanitizeRedirectPath } from "~/utils";

export let loader: LoaderFunction = () => redirect("/login");

export let action: ActionFunction = async ({ request }) => {
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirectTo");
  const safeRedirect = sanitizeRedirectPath(redirectTo, "/");

  try {
    // call authenticate as usual, in successRedirect use returnTo or a fallback
    return await authenticator.authenticate("github", request, {
      successRedirect: safeRedirect,
      failureRedirect: "/login",
    });
  } catch (error) {
    // here we catch anything authenticator.authenticate throw, this will
    // include redirects
    // if the error is a Response and is a redirect
    if (error instanceof Response) {
      // we need to append a Set-Cookie header with a cookie storing the
      // returnTo value (store the sanitized path)
      error.headers.append("Set-Cookie", await githubRedirectCookie.serialize(safeRedirect));
    }
    throw error;
  }
};
