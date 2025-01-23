import { EnvelopeIcon } from "@heroicons/react/24/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import crypto from "node:crypto";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { rootPath } from "~/utils/pathBuilder";

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
            <FormTitle
              LeadingIcon={<EnvelopeIcon className="size-6 text-cyan-500" />}
              title="Unsubscribed"
            />
            <Paragraph spacing>
              You have unsubscribed from onboarding emails, {result.email}.
            </Paragraph>
            <LinkButton variant="primary/medium" to={rootPath()}>
              Dashboard
            </LinkButton>
          </div>
        ) : (
          <div>
            <FormTitle
              LeadingIcon={<EnvelopeIcon className="size-6 text-cyan-500" />}
              title="Unsubscribe failed"
            />
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
