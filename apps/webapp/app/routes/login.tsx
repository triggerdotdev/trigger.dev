import { EnvelopeIcon } from "@heroicons/react/24/solid";
import type { LoaderFunction, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import { GitHubLoginButton } from "~/components/GitHubLoginButton";
import { LoginPromoPanel } from "~/components/LoginPromoPanel";
import { LogoSvg } from "~/components/Logo";
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
    <div className="flex h-screen w-screen justify-between overflow-y-scroll bg-slate-900">
      <LoginPromoPanel />
      <div className="flex h-full w-full grow items-center justify-center p-4">
        <div className="flex min-h-[430px] w-full max-w-xl flex-col justify-between rounded-lg bg-slate-850 shadow-md">
          <Form
            className="flex flex-grow flex-col"
            action={`/auth/github${
              data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""
            }`}
            method="post"
          >
            <a
              href="https://trigger.dev"
              className="mt-12 flex w-full justify-center px-4"
            >
              <LogoSvg className="h-14" />
            </a>
            <div className="flex flex-grow flex-col items-center justify-between px-10 pt-8 pb-12 text-center">
              <p className="text-base lg:text-lg">
                Build better workflows with Trigger.dev.
              </p>
              <GitHubLoginButton className="mx-auto whitespace-nowrap" />
              <Link
                className="flex items-center justify-center gap-1 text-sm text-slate-400 transition hover:text-slate-300"
                to="/login/magic"
              >
                <EnvelopeIcon className="h-4 w-4" />
                Continue with email
              </Link>
            </div>
          </Form>

          <div className="w-full rounded-b-lg border-t border-slate-850 bg-slate-800 px-8 py-4">
            <p className="text-center text-xs text-slate-500">
              By connecting your GitHub account you agree to our{" "}
              <a
                className="underline transition hover:text-indigo-500"
                href="https://trigger.dev/legal/terms"
                target="_blank"
                rel="noreferrer"
              >
                terms
              </a>{" "}
              and{" "}
              <a
                className="underline transition hover:text-indigo-500"
                href="https://trigger.dev/legal/privacy"
                target="_blank"
                rel="noreferrer"
              >
                privacy
              </a>{" "}
              policies.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
