import { SignIn } from "@clerk/remix";
import type { LoaderFunction, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { getUserId } from "~/services/session.server";

export const loader: LoaderFunction = async ({ request }) => {
  const userId = await getUserId(request);
  if (userId) return redirect("/");
  return json({});
};

export const meta: MetaFunction = () => {
  return {
    title: "Login",
  };
};

export default function LoginPage() {
  return (
    <div className="flex h-screen w-screen justify-between overflow-y-scroll">
      <div className="flex grow items-center justify-center bg-gradient-background h-full w-full p-4">
        <div className="mt-[100px] flex w-full max-w-xl flex-col justify-between rounded-lg border bg-white shadow-md lg:mt-0 lg:min-h-[430px]">
          <SignIn routing={"path"} path={"/login"} />
          <div className="w-full rounded-b-lg border-t bg-slate-50 px-8 py-4">
            <p className="text-center text-xs text-slate-500">
              By created an account you agree to our{" "}
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
