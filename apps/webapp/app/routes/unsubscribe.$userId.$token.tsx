import { parse } from "@conform-to/zod";
import { ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import { inspect } from "util";
import { z } from "zod";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import crypto from "node:crypto";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { prisma } from "~/db.server";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { LinkButton } from "~/components/primitives/Buttons";
import { rootPath } from "~/utils/pathBuilder";
import { FormTitle } from "~/components/primitives/FormTitle";
import { EnvelopeIcon } from "@heroicons/react/24/solid";

export const ParamsSchema = z.object({
  userId: z.string(),
  token: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { userId, token } = ParamsSchema.parse(params);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return typedjson({
        success: false as const,
        message: "User not found",
      });
    }

    //check that the token is valid for the userId
    const hashedUserId = crypto
      .createHash("sha256")
      .update(`${userId}-${env.MAGIC_LINK_SECRET}`)
      .digest("hex");
    if (hashedUserId !== token) {
      return typedjson({
        success: false as const,
        message: "This unsubscribe link was invalid so we can't unsubscribe you.",
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { marketingEmails: false },
    });

    return typedjson({ success: true as const, email: user.email });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : JSON.stringify(e);
    return typedjson({ success: false as const, message: errorMessage });
  }
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();

  return (
    <AppContainer>
      <MainCenteredContainer className="max-w-[22rem]">
        {result.success ? (
          <div>
            <FormTitle LeadingIcon="envelope" title="Unsubscribed" />
            <Paragraph spacing>
              You have unsubscribed from onboarding emails, {result.email}.
            </Paragraph>
            <LinkButton variant="primary/medium" to={rootPath()}>
              Dashboard
            </LinkButton>
          </div>
        ) : (
          <div>
            <FormTitle LeadingIcon="envelope" title="Unsubscribe failed" />
            <Paragraph spacing>{result.message}</Paragraph>
            <Paragraph spacing>
              If you believe this is a bug, please{" "}
              <TextLink href="https://trigger.dev/contact">contact support</TextLink>.
            </Paragraph>
            <LinkButton variant="primary/medium" to={rootPath()}>
              Dashboard
            </LinkButton>
          </div>
        )}
      </MainCenteredContainer>
    </AppContainer>
  );
}
