import { type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";

export const action: ActionFunction = async ({ request }) => {
  return await authenticator.logout(request, { redirectTo: "/" });
};

export const loader: LoaderFunction = async ({ request }) => {
  return await authenticator.logout(request, { redirectTo: "/" });
};
