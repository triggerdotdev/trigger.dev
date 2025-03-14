import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ExclamationTriangleIcon, FolderIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  Avatar,
  AvatarData,
  avatarIcons,
  AvatarType,
  defaultAvatarColors,
  defaultAvatarIcon,
  parseAvatar,
} from "~/components/primitives/Avatar";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { clearCurrentProject } from "~/services/dashboardPreferences.server";
import { DeleteOrganizationService } from "~/services/deleteOrganization.server";
import { logger } from "~/services/logger.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  OrganizationParamsSchema,
  organizationPath,
  organizationSettingsPath,
  rootPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Organization settings | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      avatar: true,
    },
  });

  if (!organization) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({
    organization: { ...organization, avatar: parseAvatar(organization.avatar, defaultAvatarIcon) },
  });
};

export function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; organizationSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("avatar"),
      type: AvatarType,
      name: z.string().optional(),
      hex: z.string().optional(),
    }),
    z.object({
      action: z.literal("rename"),
      organizationName: z
        .string()
        .min(3, "Organization name must have at least 3 characters")
        .max(50),
    }),
    z.object({
      action: z.literal("delete"),
      organizationSlug: z.string().superRefine((slug, ctx) => {
        if (constraints.getSlugMatch === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          const { isMatch, organizationSlug } = constraints.getSlugMatch(slug);
          if (isMatch) {
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${organizationSlug}`,
          });
        }
      }),
    }),
  ]);
}

export const action: ActionFunction = async ({ request, params }) => {
  const user = await requireUser(request);
  const { organizationSlug } = params;
  if (!organizationSlug) {
    return json({ errors: { body: "organizationSlug is required" } }, { status: 400 });
  }

  const formData = await request.formData();
  const schema = createSchema({
    getSlugMatch: (slug) => {
      return { isMatch: slug === organizationSlug, organizationSlug };
    },
  });
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    switch (submission.value.action) {
      case "rename": {
        await prisma.organization.update({
          where: {
            slug: organizationSlug,
            members: {
              some: {
                userId: user.id,
              },
            },
          },
          data: {
            title: submission.value.organizationName,
          },
        });

        return redirectWithSuccessMessage(
          organizationPath({ slug: organizationSlug }),
          request,
          `Organization renamed to ${submission.value.organizationName}`
        );
      }
      case "delete": {
        const deleteOrganizationService = new DeleteOrganizationService();
        try {
          await deleteOrganizationService.call({ organizationSlug, userId: user.id, request });

          //we need to clear the project from the session
          await clearCurrentProject({
            user,
          });
          return redirect(rootPath());
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
          logger.error("Organization could not be deleted", {
            error: errorMessage,
          });
          return redirectWithErrorMessage(
            organizationSettingsPath({ slug: organizationSlug }),
            request,
            errorMessage
          );
        }
      }
      case "avatar": {
        const avatar = AvatarData.safeParse(submission.value);

        if (!avatar.success) {
          return redirectWithErrorMessage(
            organizationSettingsPath({ slug: organizationSlug }),
            request,
            avatar.error.message
          );
        }

        await prisma.organization.update({
          where: {
            slug: organizationSlug,
            members: {
              some: {
                userId: user.id,
              },
            },
          },
          data: {
            avatar: avatar.data,
          },
        });

        return redirectWithSuccessMessage(
          organizationSettingsPath({ slug: organizationSlug }),
          request,
          `Updated logo`
        );
      }
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { organization } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [renameForm, { organizationName }] = useForm({
    id: "rename-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema(),
      });
    },
  });

  const [deleteForm, { organizationSlug }] = useForm({
    id: "delete-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({
            isMatch: slug === organization.slug,
            organizationSlug: organization.slug,
          }),
        }),
      });
    },
  });

  const isRenameLoading =
    navigation.formData?.get("action") === "rename" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const isDeleteLoading =
    navigation.formData?.get("action") === "delete" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${organization.title} organization settings`} />
      </NavBar>

      <PageBody>
        <div className="flex flex-col gap-4">
          <div>
            <LogoForm organization={organization} />
          </div>

          <div>
            <Form method="post" {...renameForm.props} className="max-w-md">
              <input type="hidden" name="action" value="rename" />
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={organizationName.id}>Rename your organization</Label>
                  <Input
                    {...conform.input(organizationName, { type: "text" })}
                    defaultValue={organization.title}
                    placeholder="Your organization name"
                    icon={FolderIcon}
                    autoFocus
                  />
                  <FormError id={organizationName.errorId}>{organizationName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"primary/small"}
                      disabled={isRenameLoading}
                      LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                    >
                      Rename organization
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>

          <div>
            <Header2 spacing>Danger zone</Header2>
            <Form
              method="post"
              {...deleteForm.props}
              className="max-w-md rounded-sm border border-rose-500/40"
            >
              <input type="hidden" name="action" value="delete" />
              <Fieldset className="p-4">
                <InputGroup>
                  <Label htmlFor={organizationSlug.id}>Delete organization</Label>
                  <Input
                    {...conform.input(organizationSlug, { type: "text" })}
                    placeholder="Your organization slug"
                    icon={ExclamationTriangleIcon}
                    autoFocus
                  />
                  <FormError id={organizationSlug.errorId}>{organizationSlug.error}</FormError>
                  <FormError>{deleteForm.error}</FormError>
                  <Hint>
                    This change is irreversible, so please be certain. Type in the Organization slug{" "}
                    <InlineCode variant="extra-small">{organization.slug}</InlineCode> and then
                    press Delete.
                  </Hint>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"danger/small"}
                      LeadingIcon={isDeleteLoading ? SpinnerWhite : TrashIcon}
                      leadingIconClassName="text-white"
                      disabled={isDeleteLoading}
                    >
                      Delete organization
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function LogoForm({ organization }: { organization: { avatar: Avatar } }) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [avatarForm] = useForm({
    id: "avatar-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema(),
      });
    },
  });

  const hex = "hex" in organization.avatar ? organization.avatar.hex : defaultAvatarColors[0];

  return (
    <Fieldset>
      <InputGroup>
        <Label>Logo</Label>
        <div className="flex items-end gap-2">
          <div className="size-20 overflow-clip rounded-sm border border-charcoal-700 bg-charcoal-850">
            <Avatar avatar={organization.avatar} className="size-20" includePadding />
          </div>
          {Object.entries(avatarIcons).map(([name]) => (
            <Form key={name} method="post" {...avatarForm.props}>
              <input type="hidden" name="action" value="avatar" />
              <input type="hidden" name="type" value="icon" />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="hex" value={hex} />
              <button
                type="submit"
                className={cn(
                  "size-10 overflow-clip rounded-sm border bg-charcoal-850",
                  organization.avatar.type === "icon" && organization.avatar.name === name
                    ? "border-2 border-text-dimmed"
                    : "border border-charcoal-700"
                )}
              >
                <Avatar
                  key={name}
                  avatar={{
                    type: "icon",
                    name,
                    hex,
                  }}
                  className="size-10"
                  includePadding
                />
              </button>
            </Form>
          ))}
        </div>
      </InputGroup>
    </Fieldset>
  );
}
