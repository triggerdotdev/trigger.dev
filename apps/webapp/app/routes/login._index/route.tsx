import type { DataFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { ServerRuntimeMetaArgs, ServerRuntimeMetaDescriptor } from "@remix-run/server-runtime";
import { getMatchesData, metaV1 } from "@remix-run/v1-meta";
import {
  TypedJsonResponse,
  TypedMetaFunction,
  UseDataFunctionReturn,
  redirect,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { LogoIcon } from "~/components/LogoIcon";
import { LogoType } from "~/components/LogoType";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { Icon } from "~/components/primitives/Icon";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import type { LoaderType as RootLoader } from "~/root";
import { isGithubAuthSupported } from "~/services/auth.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { appEnvTitleTag } from "~/utils";
import { cn } from "~/utils/cn";
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

const layout =
  "group grid place-items-center p-4 text-center overflow-hidden hover:opacity-100 hover:grayscale-0 transition";
const gridCell = "hover:bg-midnight-850 rounded-lg transition bg-midnight-850/40";
const logos =
  "h-20 w-20 opacity-20 group-hover:opacity-100 transition grayscale group-hover:grayscale-0";
const tall = "row-span-2";
const wide = "col-span-2";
const wider = "col-span-3 row-span-2";
const mediumSquare = "col-span-2 row-span-2";

export default function LoginPage() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <main className="grid h-full w-full grid-cols-12">
      <div className="border-midnight-750 z-10 col-span-5 border-r bg-midnight-850">
        <LoginForm />
      </div>
      <div className="col-span-7 grid h-full w-full grid-flow-row grid-cols-5 grid-rows-6 gap-4 p-4">
        <div className={cn(layout, gridCell, mediumSquare)}>1</div>
        <LoginTooltip
          side="bottom"
          content="Use our Supabase Integration in your Job to react to changes in your database."
        >
          <div className={cn(layout, gridCell)}>
            <Icon icon="supabase" className={logos} />
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell, mediumSquare)}>4</div>
        <LoginTooltip
          side="bottom"
          content="Trigger payments, emails, subscription upgrades and more with our Stripe Integration."
        >
          <div className={cn("", layout, gridCell)}>
            <Icon icon="stripe" className={logos} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="top" content="❤️ Loved by developers">
          <div className={cn(layout, gridCell, wider)}>
            <div className="p-4">
              <Header3 className="relative text-2xl font-normal leading-8 text-dimmed before:absolute before:-top-10 before:left-2 before:-z-10 before:text-8xl before:text-indigo-500 before:opacity-20 before:content-['❝']">
                Trigger.dev is redefining background jobs for modern developers.
              </Header3>
              <Paragraph variant="small" className="mt-4 text-slate-600">
                Paul Copplestone, Supabase
              </Paragraph>
            </div>
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell)}>
          <Icon icon="airtable" className={logos} />
        </div>
        <div className={cn(layout, gridCell)}>
          <Icon icon="typeform" className={logos} />
        </div>
        <div className={cn(layout, gridCell, mediumSquare)}>8</div>
        <div className={cn(layout, gridCell, tall)}>9</div>
        <div className={cn(layout, gridCell, mediumSquare)}>10</div>
        <div className={cn(layout, gridCell, wide)}>11</div>
      </div>
    </main>
  );
}

function LoginTooltip({
  children,
  side,
  content,
}: {
  children: React.ReactNode;
  side: "top" | "bottom" | "left" | "right";
  content: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="max-w-xs py-2 text-center" side={side}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function LoginForm() {
  const data = useTypedLoaderData<typeof loader>();
  return (
    <div className="h-full p-6">
      <div className="flex items-center justify-between">
        <a href="https://trigger.dev">
          <LogoType className="w-36" />
        </a>
        <LinkButton to="https://trigger.dev/docs" variant={"secondary/small"} LeadingIcon="docs">
          Documentation
        </LinkButton>
      </div>
      <div className="flex h-full items-center justify-center">
        <Form
          action={`/auth/github${data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""}`}
          method="post"
        >
          <div className="flex flex-col items-center gap-y-6">
            <div>
              <Header1 className="pb-4 font-normal lg:text-3xl">Welcome</Header1>
              <Paragraph variant="small" className="mb-6">
                Create an account or login
              </Paragraph>
              <Fieldset>
                <div className="flex flex-col gap-y-2">
                  {data.showGithubAuth && (
                    <Button
                      type="submit"
                      variant="primary/large"
                      fullWidth
                      data-action="continue with github"
                    >
                      <NamedIcon name={"github"} className={"mr-1.5 h-4 w-4"} />
                      Continue with GitHub
                    </Button>
                  )}
                  <LinkButton
                    to="/login/magic"
                    variant="secondary/large"
                    fullWidth
                    data-action="continue with email"
                  >
                    <NamedIcon
                      name={"envelope"}
                      className={"mr-1.5 h-4 w-4 text-dimmed transition group-hover:text-bright"}
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
                  <TextLink href="https://trigger.dev/legal/privacy" target="_blank">
                    privacy
                  </TextLink>
                  {" "}policy.
                </Paragraph>
              </Fieldset>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}
