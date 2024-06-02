import { Form } from "@remix-run/react";
import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { PlainClient } from "@team-plain/typescript-sdk";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { useUser } from "~/hooks/useUser";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { organizationPath } from "~/utils/pathBuilder";
import v3Icon from "~/assets/icons/v3.svg";
import { CheckCircleIcon } from "@heroicons/react/20/solid";

const ParamSchema = z.object({
  organizationSlug: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage("/", request, "Invalid request method");
  }

  const user = await requireUser(request);
  const { organizationSlug } = ParamSchema.parse(params);

  const failedRedirectPath = organizationPath({ slug: organizationSlug });

  try {
    if (!env.PLAIN_API_KEY) {
      return redirectWithErrorMessage(
        failedRedirectPath,
        request,
        "Error requesting V3 access: Plain API key"
      );
    }

    //mark them as having requested v3
    const organization = await prisma.organization.update({
      where: {
        slug: organizationSlug,
        members: {
          some: {
            userId: user.id,
          },
        },
      },
      data: {
        hasRequestedV3: true,
      },
    });

    //update Plain
    const client = new PlainClient({
      apiKey: env.PLAIN_API_KEY,
    });

    const upsertCustomerRes = await client.upsertCustomer({
      identifier: {
        emailAddress: user.email,
      },
      onCreate: {
        fullName: user.name ?? user.email,
        email: {
          email: user.email,
          isVerified: true,
        },
      },
      onUpdate: {},
    });

    if (upsertCustomerRes.error) {
      logger.error("Error upserting customer", upsertCustomerRes.error);
      return redirectWithErrorMessage(failedRedirectPath, request, "Error requesting V3 access");
    }

    const groupResult = await client.addCustomerToCustomerGroups({
      customerId: upsertCustomerRes.data.customer.id,
      customerGroupIdentifiers: [
        {
          customerGroupKey: "interested-in-v3",
        },
      ],
    });

    if (groupResult.error) {
      logger.error("Error adding customer to group", groupResult.error);
      return redirectWithErrorMessage(failedRedirectPath, request, "Error requesting V3 access");
    }

    const createThreadRes = await client.createThread({
      customerIdentifier: {
        customerId: upsertCustomerRes.data.customer.id,
      },
      title: "v3 early access request",
      components: [
        {
          componentText: {
            text: `${upsertCustomerRes.data.customer.email.email} has been added to the v3 early access group`,
          },
        },
        {
          componentText: {
            text: `Company: ${organization.title ?? "–"}`,
          },
        },
      ],
    });

    if (createThreadRes.error) {
      logger.error("Error creating thread", createThreadRes.error);
      return redirectWithErrorMessage(failedRedirectPath, request, "Error requesting V3 access");
    }

    return redirectWithSuccessMessage(
      organizationPath(organization),
      request,
      "V3 access requested"
    );
  } catch (error) {
    logger.error("Error requesting V3 access", { error });
    return redirectWithErrorMessage(failedRedirectPath, request, "Error requesting V3 access");
  }
};

export function RequestV3Access({
  hasRequestedV3,
  organizationSlug,
  projectsCount,
}: {
  hasRequestedV3: boolean;
  organizationSlug: string;
  projectsCount: number;
}) {
  const user = useUser();

  if (hasRequestedV3) {
    return (
      <MainCenteredContainer>
        <div>
          <div className="relative mb-4 flex size-9">
            <img src={v3Icon} alt="v3" width={32} height={32} />
            <div className="absolute right-0 top-0 size-4 rounded-full bg-background-dimmed">
              <CheckCircleIcon className="size-4 text-success" />
            </div>
          </div>
          <Paragraph spacing variant="base/bright">
            We’ve received your request for v3 and we’ll notify you as soon as you have access.
            We’re granting new users access every day so you won’t be waiting long.
          </Paragraph>
          <Paragraph spacing variant="base/bright">
            Right now v3 is completely free to use but{" "}
            <TextLink href="https://trigger.dev/blog/v3-developer-preview-launch/#cloud-pricing">
              paid tiers
            </TextLink>{" "}
            will be introduced soon.
          </Paragraph>
          <Paragraph spacing variant="base/bright">
            In the meantime, check out the{" "}
            <TextLink href="https://trigger.dev/docs">v3 docs</TextLink>, the{" "}
            <TextLink href="https://trigger.dev/blog/v3-developer-preview-launch/">
              v3 blog post
            </TextLink>{" "}
            and <TextLink href="https://trigger.dev/discord">join our Discord</TextLink>.
          </Paragraph>
        </div>
      </MainCenteredContainer>
    );
  }

  return (
    <MainCenteredContainer>
      <img src={v3Icon} alt="v3" width={32} height={32} className="mb-4" />
      <Form action={`/resources/orgs/${organizationSlug}/v3-access`} method="post">
        {projectsCount > 0 ? (
          <Paragraph spacing variant="base/bright">
            You can no longer create v2 projects and your organization doesn't have access to v3
            yet. We are approving access requests daily.
          </Paragraph>
        ) : (
          <Paragraph spacing variant="base/bright">
            Trigger.dev v3 is currently in Developer Preview and we’re operating a waitlist as we
            focus on the platform’s reliability and scaleability.
          </Paragraph>
        )}
        <Paragraph spacing variant="base/bright">
          For more info, check out our{" "}
          <TextLink href="https://trigger.dev/blog/v3-developer-preview-launch/">
            v3 blog post
          </TextLink>
          .
        </Paragraph>
        <div className="mt-2 flex items-center justify-between gap-3">
          {projectsCount > 0 ? (
            <LinkButton variant="tertiary/small" to={organizationPath({ slug: organizationSlug })}>
              Cancel
            </LinkButton>
          ) : null}
          <Button variant="primary/small" type="submit">
            Request access
          </Button>
        </div>
      </Form>
    </MainCenteredContainer>
  );
}
