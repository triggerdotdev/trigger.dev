import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { getMatchesData, metaV1 } from "@remix-run/v1-meta";
import {
  TypedMetaFunction,
  UseDataFunctionReturn,
  redirect,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import type { LoaderType as RootLoader } from "~/root";
import { isGithubAuthSupported } from "~/services/auth.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import {
  getUserSession,
  commitSession as commitAuthSession,
} from "~/services/sessionStorage.server";
import { appEnvTitleTag } from "~/utils";
import { requestUrl } from "~/utils/requestUrl.server";

export const meta: TypedMetaFunction<typeof loader> = (args) => {
  const matchesData = getMatchesData(args) as { root: UseDataFunctionReturn<RootLoader> };

  return metaV1(args, {
    title: `Login to Trigger.dev${appEnvTitleTag(matchesData.root.appEnv)}`,
  });
};

export type PromiseReturnType<T extends (...arguments_: any) => Promise<any>> = Awaited<
  ReturnType<T>
>;

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  if (userId) return redirect("/");

  const url = requestUrl(request);
  const redirectTo = url.searchParams.get("redirectTo");

  const session = await getUserSession(request);
  const error = session.get("auth:error");

  let githubError: string | undefined;
  if (error) {
    if ("message" in error) {
      githubError = error.message;
    } else {
      githubError = JSON.stringify(error, null, 2);
    }
  }

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return typedjson(
      { redirectTo, showGithubAuth: isGithubAuthSupported, githubError },
      {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      }
    );
  } else {
    return typedjson(
      { redirectTo: null, showGithubAuth: isGithubAuthSupported, githubError },
      {
        headers: { "Set-Cookie": await commitAuthSession(session) },
      }
    );
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
          <Header1 className="pb-4 font-normal sm:text-2xl md:text-3xl lg:text-4xl">
            Welcome
          </Header1>
          <Paragraph variant="base" className="mb-6">
            Create an account or login
          </Paragraph>
          <Fieldset className="w-full">
            <div className="flex flex-col items-center gap-y-2">
              {data.showGithubAuth && (
                <Button
                  type="submit"
                  variant="primary/extra-large"
                  fullWidth
                  data-action="continue with github"
                >
                  <NamedIcon name={"github"} className={"mr-2 h-6 w-6"} />
                  Continue with GitHub
                </Button>
              )}
              <LinkButton
                to="/login/magic"
                variant="secondary/extra-large"
                fullWidth
                data-action="continue with email"
              >
                <NamedIcon
                  name={"envelope"}
                  className={
                    "mr-1.5 h-4 w-4 text-text-dimmed transition group-hover:text-text-bright"
                  }
                />
                Continue with Email
              </LinkButton>

              {data.githubError && <FormError>{data.githubError}</FormError>}
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
