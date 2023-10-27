import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import {
  TypedMetaFunction,
  UseDataFunctionReturn,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { z } from "zod";
import { LogoIcon } from "~/components/LogoIcon";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { authenticator } from "~/services/auth.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import magicLinkIcon from "./login.magic.svg";
import type { LoaderType as RootLoader } from "~/root";
import { appEnvTitleTag } from "~/utils";
import { TextLink } from "~/components/primitives/TextLink";
import { FormError } from "~/components/primitives/FormError";
import { getMatchesData, metaV1 } from "@remix-run/v1-meta";

export const meta: TypedMetaFunction<typeof loader> = (args) => {
  const matchesData = getMatchesData(args) as { root: UseDataFunctionReturn<RootLoader> };

  return metaV1(args, {
    title: `Login to Trigger.dev${appEnvTitleTag(matchesData.root.appEnv)}`,
  });
};

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const session = await getUserSession(request);
  const error = session.get("auth:error");

  let magicLinkError: string | undefined;
  if (error) {
    if ("message" in error) {
      magicLinkError = error.message;
    } else {
      magicLinkError = JSON.stringify(error, null, 2);
    }
  }

  return typedjson(
    {
      magicLinkSent: session.has("triggerdotdev:magiclink"),
      magicLinkError,
    },
    {
      headers: { "Set-Cookie": await commitSession(session) },
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const clonedRequest = request.clone();

  const payload = Object.fromEntries(await clonedRequest.formData());

  const { action } = z
    .object({
      action: z.enum(["send", "reset"]),
    })
    .parse(payload);

  if (action === "send") {
    return authenticator.authenticate("email-link", request, {
      successRedirect: "/login/magic",
      failureRedirect: "/login/magic",
    });
  } else {
    const session = await getUserSession(request);
    session.unset("triggerdotdev:magiclink");

    return redirect("/login/magic", {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    });
  }
}

export default function LoginMagicLinkPage() {
  const { magicLinkSent, magicLinkError } = useTypedLoaderData<typeof loader>();
  const navigate = useNavigation();

  const isLoading =
    (navigate.state === "loading" || navigate.state === "submitting") &&
    navigate.formAction !== undefined &&
    navigate.formData?.get("action") === "send";

  return (
    <AppContainer showBackgroundGradient={true}>
      <MainCenteredContainer>
        <Form method="post">
          <div className="flex flex-col items-center">
            <a href="https://trigger.dev">
              <LogoIcon className="mb-4 h-16 w-16" />
            </a>

            {magicLinkSent ? (
              <>
                <FormTitle divide={false} title="We've sent you a magic link!" />
                <img src={magicLinkIcon} className="mb-4 h-12 w-12" />
                <Fieldset className="flex w-full flex-col items-center gap-y-2">
                  <Paragraph className="mb-6 text-center">
                    We sent you an email which contains a magic link that will log you in to your
                    account.
                  </Paragraph>
                  <FormButtons
                    cancelButton={
                      <Button
                        type="submit"
                        name="action"
                        value="reset"
                        variant="tertiary/small"
                        LeadingIcon="arrow-left"
                        leadingIconClassName="text-dimmed group-hover:text-bright transition"
                        data-action="re-enter email"
                      >
                        Re-enter email
                      </Button>
                    }
                    confirmButton={
                      <LinkButton
                        to="/login"
                        variant="tertiary/small"
                        data-action="log in using another option"
                      >
                        Log in using another option
                      </LinkButton>
                    }
                  />
                </Fieldset>
              </>
            ) : (
              <>
                <FormTitle divide={false} title="Welcome to Trigger.dev" className="mb-2 pb-0" />
                <Paragraph variant="small" className="mb-4 text-center">
                  Create an account or login using your email
                </Paragraph>
                <Fieldset className="flex w-full flex-col items-center gap-y-2">
                  <InputGroup>
                    <Label>Your email address</Label>
                    <Input
                      type="email"
                      name="email"
                      spellCheck={false}
                      placeholder="Email Address"
                      required
                      autoFocus
                    />
                  </InputGroup>

                  <Button
                    name="action"
                    value="send"
                    type="submit"
                    variant="primary/medium"
                    disabled={isLoading}
                    fullWidth
                    data-action="send a magic link"
                  >
                    <NamedIcon
                      name={isLoading ? "spinner-white" : "envelope"}
                      className={"mr-1.5 h-4 w-4 text-white transition group-hover:text-bright"}
                    />
                    {isLoading ? "Sending…" : "Send a magic link"}
                  </Button>
                  {magicLinkError && <FormError>{magicLinkError}</FormError>}
                </Fieldset>
                <Paragraph variant="extra-small" className="my-4 text-center">
                  By logging in with your email you agree to our{" "}
                  <TextLink href="https://trigger.dev/legal" target="_blank">
                    terms
                  </TextLink>{" "}
                  and{" "}
                  <TextLink href="https://trigger.dev/legal/privacy" target="_blank">
                    privacy
                  </TextLink>{" "}
                  policy.
                </Paragraph>

                <LinkButton
                  to="/login"
                  variant={"tertiary/small"}
                  LeadingIcon={"arrow-left"}
                  leadingIconClassName="text-dimmed group-hover:text-bright transition"
                  data-action="all login options"
                >
                  All login options
                </LinkButton>
              </>
            )}
            <div className="mt-8 rounded border border-border px-6 py-4">
              <Paragraph variant="small" className="mb-2 text-center">
                Having login issues?
              </Paragraph>
              <Paragraph variant="extra-small" className="text-center">
                Ensure the Magic Link email isn't in your spam folder. If the problem persists,{" "}
                <TextLink href="mailto:help@trigger.dev" target="_blank">
                  drop us an email
                </TextLink>{" "}
                or let us know on{" "}
                <TextLink href="https://trigger.dev/discord" target="_blank">
                  Discord
                </TextLink>
                .
              </Paragraph>
            </div>
          </div>
        </Form>
      </MainCenteredContainer>
    </AppContainer>
  );
}
