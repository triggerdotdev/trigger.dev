import { EnvelopeIcon } from "@heroicons/react/24/solid";
import type { LoaderFunction, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import { GitHubLoginButton } from "~/components/GitHubLoginButton";
import { LoginPromoPanel } from "~/components/LoginPromoPanel";
import { Logo } from "~/components/Logo";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";

type LoaderData = {
  redirectTo?: string;
};

export const loader: LoaderFunction = async ({ request }) => {
  const userId = await getUserId(request);
  if (userId) return redirect("/");

  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirectTo");

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return json<LoaderData>(
      { redirectTo },
      {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      }
    );
  } else {
    return json({});
  }
};

export const meta: MetaFunction = () => {
  return {
    title: "Login",
  };
};

export default function LoginPage() {
  const data = useLoaderData<LoaderData>();
  return (
    <div className="flex h-screen w-screen justify-between overflow-y-scroll">
      <LoginPromoPanel />
      <div className="flex grow items-center justify-center bg-gradient-background h-full w-full p-4">
        <div className="mt-[100px] flex w-full max-w-xl flex-col justify-between rounded-lg border bg-white shadow-md lg:mt-0 lg:min-h-[430px]">
          <Form
            className="flex flex-col"
            action={`/auth/github${
              data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""
            }`}
            method="post"
          >
            <div className="flex flex-col items-center px-4 pt-6 pb-4 text-center lg:px-10">
              <a href="https://apihero.run">
                <Logo className="mb-4 h-10 w-auto lg:mb-6 lg:mt-8 lg:h-14" />
              </a>
              <h2 className="mb-2 text-2xl font-bold tracking-tight text-slate-700 lg:text-4xl">
                Welcome to Trigger.dev
              </h2>
              <p className="mb-4 text-base lg:mb-12 lg:text-lg">
                Connect your GitHub account to get started.
              </p>
              <GitHubLoginButton className="mx-auto whitespace-nowrap" />
            </div>
          </Form>
          {
            <Link
              className="mb-4 flex items-center justify-center gap-1 text-sm text-slate-500 transition hover:text-slate-800"
              to="/login/magic"
            >
              <EnvelopeIcon className="h-4 w-4" />
              Continue with email
            </Link>
          }
          <div className="w-full rounded-b-lg border-t bg-slate-50 px-8 py-4">
            <p className="text-center text-xs text-slate-500">
              By connecting your GitHub account you agree to our{" "}
              <Link
                className="underline transition hover:text-blue-500"
                to="/legal/terms"
              >
                terms
              </Link>{" "}
              and{" "}
              <Link
                className="underline transition hover:text-blue-500"
                to="/legal/privacy"
              >
                privacy
              </Link>{" "}
              policies.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
