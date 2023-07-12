import type { LoaderArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import {
  TypedMetaFunction,
  redirect,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { LogoIcon } from "~/components/LogoIcon";
import {
  AppContainer,
  MainCenteredContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormTitle } from "~/components/primitives/FormTitle";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import type { LoaderType as RootLoader } from "~/root";
import { isGithubAuthSupported } from "~/services/auth.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { appEnvTitleTag } from "~/utils";
import { requestUrl } from "~/utils/requestUrl.server";

export const meta: TypedMetaFunction<typeof loader, { root: RootLoader }> = ({
  parentsData,
}) => ({
  title: `Login to Trigger.dev${appEnvTitleTag(parentsData?.root.appEnv)}`,
});

export async function loader({ request }: LoaderArgs) {
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
    <AppContainer showBackgroundGradient={true}>
      <MainCenteredContainer>
        <Form
          action={`/auth/github${
            data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""
          }`}
          method="post"
        >
          <div className="flex flex-col items-center">
            <a href="https://trigger.dev">
              <LogoIcon className="mb-4 h-16 w-16" />
            </a>
            <FormTitle divide={false} title="Log in to Trigger.dev" />
            <Fieldset>
              <div className="flex flex-col gap-y-2">
                {data.showGithubAuth && (
                  <Button type="submit" variant="primary/large" fullWidth>
                    <NamedIcon name={"github"} className={"mr-1.5 h-4 w-4"} />
                    Continue with GitHub
                  </Button>
                )}
                <LinkButton
                  to="/login/magic"
                  variant="secondary/large"
                  fullWidth
                >
                  <NamedIcon
                    name={"envelope"}
                    className={
                      "mr-1.5 h-4 w-4 text-dimmed transition group-hover:text-bright"
                    }
                  />
                  Continue with Email
                </LinkButton>
              </div>
              <Paragraph variant="extra-small" className="mt-2 text-center">
                By signing up you agree to our{" "}
                <TextLink href="https://trigger.dev/legal" target="_blank">
                  terms
                </TextLink>
                {" "}and{" "}
                <TextLink
                  href="https://trigger.dev/legal/privacy"
                  target="_blank"
                >
                  privacy
                </TextLink>
                {" "}policy.
              </Paragraph>
            </Fieldset>
          </div>
        </Form>
      </MainCenteredContainer>
    </AppContainer>
  );
}
