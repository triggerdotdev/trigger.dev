import { ArrowLeftIcon, EnvelopeIcon } from "@heroicons/react/20/solid";
import { InboxArrowDownIcon } from "@heroicons/react/24/solid";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { authenticator } from "~/services/auth.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";

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
    <LoginPageLayout>
      <Form method="post">
        <div className="flex flex-col items-center justify-center">
          {magicLinkSent ? (
            <>
              <Header1 className="pb-6 text-center text-xl font-normal leading-7 md:text-xl lg:text-2xl">
                We've sent you a magic link!
              </Header1>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InboxArrowDownIcon className="mb-4 h-12 w-12 text-indigo-500" />
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
                      variant="minimal/small"
                      LeadingIcon={ArrowLeftIcon}
                      leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
                      data-action="re-enter email"
                    >
                      Re-enter email
                    </Button>
                  }
                  confirmButton={
                    <LinkButton
                      to="/login"
                      variant="minimal/small"
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
              <Header1 className="pb-4 font-semibold sm:text-2xl md:text-3xl lg:text-4xl">
                Welcome
              </Header1>
              <Paragraph variant="base" className="mb-6 text-center">
                Create an account or login using email
              </Paragraph>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InputGroup>
                  <Input
                    type="email"
                    name="email"
                    spellCheck={false}
                    placeholder="Email Address"
                    variant="large"
                    required
                    autoFocus
                  />
                </InputGroup>

                <Button
                  name="action"
                  value="send"
                  type="submit"
                  variant="primary/large"
                  disabled={isLoading}
                  fullWidth
                  data-action="send a magic link"
                >
                  {isLoading ? (
                    <Spinner className="mr-2 size-5" color="white" />
                  ) : (
                    <EnvelopeIcon className="mr-2 size-5 text-text-bright" />
                  )}
                  {isLoading ? (
                    <span className="text-text-bright">Sending…</span>
                  ) : (
                    <span className="text-text-bright">Send a magic link</span>
                  )}
                </Button>
                {magicLinkError && <FormError>{magicLinkError}</FormError>}
              </Fieldset>
              <Paragraph variant="extra-small" className="mb-4 mt-6 text-center">
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

              <LinkButton
                to="/login"
                variant={"minimal/small"}
                LeadingIcon={ArrowLeftIcon}
                leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
                data-action="all login options"
              >
                All login options
              </LinkButton>
            </>
          )}
        </div>
      </Form>
    </LoginPageLayout>
  );
}
