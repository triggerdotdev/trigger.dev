import colorWheelIcon from "../../assets/images/color-wheel.png";
import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  CheckIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, type MetaFunction, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import {
  Avatar,
  AvatarData,
  avatarIcons,
  AvatarType,
  defaultAvatar,
  parseAvatar,
  defaultAvatarHex,
  defaultAvatarColors,
} from "~/components/primitives/Avatar";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import {
  Popover,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
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
    organization: { ...organization, avatar: parseAvatar(organization.avatar, defaultAvatar) },
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
          organizationSettingsPath({ slug: organizationSlug }),
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
          `Updated icon`
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
        <MainHorizontallyCenteredContainer>
          <div className="mb-3 border-b border-grid-dimmed pb-3">
            <Header2>Settings</Header2>
          </div>
          <div className="flex flex-col gap-6">
            <div>
              <LogoForm organization={organization} />
            </div>

            <div>
              <Form method="post" {...renameForm.props}>
                <input type="hidden" name="action" value="rename" />
                <Fieldset className="gap-y-0">
                  <InputGroup fullWidth>
                    <Label htmlFor={organizationName.id}>Organization name</Label>
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
                        variant={"secondary/small"}
                        disabled={isRenameLoading}
                        LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                      >
                        Rename organization
                      </Button>
                    }
                    className="border-t-0"
                  />
                </Fieldset>
              </Form>
            </div>

            <div>
              <Header2 spacing>Danger zone</Header2>
              <Form
                method="post"
                {...deleteForm.props}
                className="w-full rounded-sm border border-rose-500/40"
              >
                <input type="hidden" name="action" value="delete" />
                <Fieldset className="p-4">
                  <InputGroup>
                    <Label htmlFor={organizationSlug.id}>Delete organization</Label>
                    <Input
                      {...conform.input(organizationSlug, { type: "text" })}
                      placeholder="Your organization slug"
                      icon={ExclamationTriangleIcon}
                      fullWidth
                    />
                    <FormError id={organizationSlug.errorId}>{organizationSlug.error}</FormError>
                    <FormError>{deleteForm.error}</FormError>
                    <Hint>
                      This change is irreversible, so please be certain. Type in the Organization
                      slug <InlineCode variant="extra-small">{organization.slug}</InlineCode> and
                      then press Delete.
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
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function LogoForm({ organization }: { organization: { avatar: Avatar; title: string } }) {
  const navigation = useNavigation();

  const isSubmitting =
    navigation.state != "idle" && navigation.formData?.get("action") === "avatar";

  const avatar = navigation.formData
    ? avatarFromFormData(navigation.formData) ?? organization.avatar
    : organization.avatar;

  const hex = "hex" in avatar ? avatar.hex : defaultAvatarHex;

  return (
    <Fieldset>
      <InputGroup fullWidth>
        <Label>Icon</Label>
        <div className="flex w-full items-end justify-between gap-2">
          <div className="grid place-items-center overflow-hidden rounded-sm border border-charcoal-750 bg-background-bright">
            <Avatar avatar={avatar} size={5} includePadding orgName={organization.title} />
          </div>
          {/* Letters */}
          <Form method="post">
            <input type="hidden" name="action" value="avatar" />
            <input type="hidden" name="type" value="letters" />
            <input type="hidden" name="hex" value={hex} />
            <button
              type="submit"
              className={cn(
                "box-content grid size-10 place-items-center rounded-sm border-2 bg-charcoal-775",
                avatar.type === "letters"
                  ? undefined
                  : "border-charcoal-775 hover:border-charcoal-600"
              )}
              style={{
                borderColor: avatar.type === "letters" ? hex : undefined,
              }}
            >
              <Avatar
                avatar={{
                  type: "letters",
                  hex,
                }}
                size={2.5}
                includePadding
                orgName={organization.title}
              />
            </button>
          </Form>
          {/* Icons */}
          {Object.entries(avatarIcons).map(([name]) => (
            <Form key={name} method="post">
              <input type="hidden" name="action" value="avatar" />
              <input type="hidden" name="type" value="icon" />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="hex" value={hex} />
              <button
                type="submit"
                className={cn(
                  "box-content grid size-10 place-items-center rounded-sm border-2 bg-charcoal-775",
                  avatar.type === "icon" && avatar.name === name
                    ? undefined
                    : "border-charcoal-775 hover:border-charcoal-600"
                )}
                style={{
                  borderColor: avatar.type === "icon" && avatar.name === name ? hex : undefined,
                }}
              >
                <Avatar
                  key={name}
                  avatar={{
                    type: "icon",
                    name,
                    hex,
                  }}
                  size={2.5}
                  includePadding
                  orgName={organization.title}
                />
              </button>
            </Form>
          ))}
          {/* Hex */}
          <HexPopover avatar={avatar} hex={hex} />
        </div>
      </InputGroup>
    </Fieldset>
  );
}

function HexPopover({ avatar, hex }: { avatar: Avatar; hex: string }) {
  return (
    <Popover>
      <PopoverTrigger className="box-content grid size-10 place-items-center rounded-sm border-2 border-charcoal-775 bg-charcoal-775 hover:border-charcoal-600">
        <img src={colorWheelIcon} className="m-0 block size-[30px] p-0" />
      </PopoverTrigger>
      <PopoverContent
        className="overflow-y-auto p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <Form method="post" className="flex w-fit min-w-40 flex-col gap-1 ">
          <input type="hidden" name="action" value="avatar" />
          <input type="hidden" name="type" value={avatar.type} />
          {"name" in avatar && <input type="hidden" name="name" value={avatar.name} />}
          {defaultAvatarColors.map((color) => (
            <Button
              key={color.hex}
              name="hex"
              value={color.hex}
              type="submit"
              variant="small-menu-item"
              LeadingIcon={
                <div
                  className="size-4 rounded-full"
                  style={{
                    backgroundColor: color.hex,
                  }}
                />
              }
              TrailingIcon={hex === color.hex && <CheckIcon className="size-4 text-text-dimmed" />}
              trailingIconClassName="ml-4"
              fullWidth
              textAlignLeft
              className={cn(
                "group-hover:bg-charcoal-700",
                hex === color.hex ? "bg-charcoal-750 group-hover:bg-charcoal-600/50" : undefined
              )}
            >
              {color.name}
            </Button>
          ))}
        </Form>
      </PopoverContent>
    </Popover>
  );
}

function avatarFromFormData(formData: FormData): Avatar | undefined {
  const action = formData.get("action");
  if (!action || action !== "avatar") {
    return undefined;
  }

  const type = formData.get("type");
  const hex = formData.get("hex");

  if (type === "letters") {
    return {
      type: "letters",
      hex: hex as string,
    };
  }

  if (type === "icon") {
    return {
      type: "icon",
      name: formData.get("name") as string,
      hex: hex as string,
    };
  }

  return undefined;
}
