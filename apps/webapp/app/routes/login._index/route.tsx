import { EnvelopeIcon } from "@heroicons/react/20/solid";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { GitHubLightIcon } from "@trigger.dev/companyicons";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { isGithubAuthSupported } from "~/services/auth.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";

export const meta: MetaFunction = ({ matches }) => {
  const parentMeta = matches
    .flatMap((match) => match.meta ?? [])
    .filter((meta) => {
      if ("title" in meta) return false;
      if ("name" in meta && meta.name === "viewport") return false;
      return true;
    });

  return [
    ...parentMeta,
    { title: `Login to Trigger.dev` },
    {
      name: "viewport",
      content: "width=device-width,initial-scale=1",
    },
  ];
};

export type PromiseReturnType<T extends (...arguments_: any) => Promise<any>> = Awaited<
  ReturnType<T>
>;

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  if (userId) return redirect("/");

  const url = requestUrl(request);
  const redirectTo = url.searchParams.get("redirectTo");

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return typedjson(
      { redirectTo, showGithubAuth: isGithubAuthSupported },
      {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      }
    );
  } else {
    return typedjson({
      redirectTo: null,
      showGithubAuth: isGithubAuthSupported,
    });
  }
}

export default function LoginPage() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <LoginPageLayout>
      <Form
        action={`/auth/github${data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""}`}
        method="post"
        className="w-full"
      >
        <div className="flex flex-col items-center">
          <Header1 className="pb-4 font-semibold sm:text-2xl md:text-3xl lg:text-4xl">
            Welcome
          </Header1>
          <Paragraph variant="base" className="mb-6">
            Create an account or login
          </Paragraph>
          <Fieldset className="w-full">
            <div className="flex flex-col gap-y-2">
              {data.showGithubAuth && (
                <Button
                  type="submit"
                  variant="primary/extra-large"
                  fullWidth
                  data-action="continue with github"
                >
                  <GitHubLightIcon className={"mr-2 size-5"} />
                  <span className="text-text-bright">Continue with GitHub</span>
                </Button>
              )}
              <LinkButton
                to="/login/magic"
                variant="secondary/extra-large"
                fullWidth
                data-action="continue with email"
                className="text-text-bright"
              >
                <EnvelopeIcon className="mr-2 size-5 text-text-bright" />
                Continue with Email
              </LinkButton>
            </div>
            <Paragraph variant="extra-small" className="mt-2 text-center">
              By signing up you agree to our{" "}
              <TextLink href="https://trigger.dev/legal" target="_blank">
                terms
              </TextLink>
              {" "}and{" "}
              <TextLink href="https://trigger.dev/legal/privacy" target="_blank">
                privacy
              </TextLink>
              {" "}policy.
            </Paragraph>
          </Fieldset>
        </div>
      </Form>
    </LoginPageLayout>
  );
}
