import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BookOpenIcon, ShieldCheckIcon, TrashIcon } from "@heroicons/react/20/solid";
import { ShieldExclamationIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, type MetaFunction, useActionData, useFetcher } from "@remix-run/react";
import { type ActionFunction, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { prisma } from "~/db.server";
import { rbac, SYSTEM_ROLE_IDS } from "~/services/rbac.server";
import {
  type CreatedPersonalAccessToken,
  type ObfuscatedPersonalAccessToken,
  createPersonalAccessToken,
  getValidPersonalAccessTokens,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, personalAccessTokensPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Personal Access Tokens | Trigger.dev`,
    },
  ];
};

// PATs aren't org-scoped, but role/permission catalogues are seeded
// per-org in enterprise's allRoles. To get the canonical system roles
// (Owner/Admin/Member/Viewer — orgId IS NULL on those rows), we hand
// allRoles any orgId the user belongs to and filter down to system
// roles. This is a UI-only convenience — the chosen role becomes a
// global TokenRole row that applies wherever the PAT is used. Custom
// (org-defined) roles are out of scope for v1: their org-binding
// semantics for a multi-org user's PAT need a separate design pass.
async function loadSystemRolesForUser(userId: string) {
  const orgMember = await prisma.orgMember.findFirst({
    where: { userId },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!orgMember) return { roles: [], userRoleId: null as string | null };

  const allRoles = await rbac.allRoles(orgMember.organizationId);
  const systemRoles = allRoles.filter((r) => r.isSystem);

  const userRole = await rbac.getUserRole({
    userId,
    organizationId: orgMember.organizationId,
  });

  return { roles: systemRoles, userRoleId: userRole?.id ?? null };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  try {
    const [personalAccessTokens, { roles, userRoleId }] = await Promise.all([
      getValidPersonalAccessTokens(userId),
      loadSystemRolesForUser(userId),
    ]);

    // Default the role picker to the user's own role in their primary
    // org so a freshly-created PAT isn't more privileged than the
    // person creating it. Falls back to Member if they don't have one
    // (new user, OSS path with no role assignments yet).
    const defaultRoleId = userRoleId ?? SYSTEM_ROLE_IDS.member;

    return typedjson({
      personalAccessTokens,
      roles,
      defaultRoleId,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

const CreateTokenSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    tokenName: z
      .string({ required_error: "You must enter a name" })
      .min(2, "Your name must be at least 2 characters long")
      .max(50),
    // Optional — when the RBAC plugin isn't installed (OSS), the UI
    // hides the dropdown and submits no roleId; the action passes that
    // through and createPersonalAccessToken just doesn't write a
    // TokenRole row.
    roleId: z.string().optional(),
  }),
  z.object({
    action: z.literal("revoke"),
    tokenId: z.string(),
  }),
]);

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const submission = parse(formData, { schema: CreateTokenSchema });

  if (!submission.value) {
    return json(submission);
  }

  switch (submission.value.action) {
    case "create": {
      try {
        const tokenResult = await createPersonalAccessToken({
          name: submission.value.tokenName,
          userId,
          roleId: submission.value.roleId,
        });

        return json({ ...submission, payload: { token: tokenResult } });
      } catch (error: any) {
        return json({ errors: { body: error.message } }, { status: 400 });
      }
    }
    case "revoke": {
      try {
        await revokePersonalAccessToken(submission.value.tokenId, userId);

        return redirectWithSuccessMessage(
          personalAccessTokensPath(),
          request,
          "Personal Access Token revoked"
        );
      } catch (error: any) {
        return json({ errors: { body: error.message } }, { status: 400 });
      }
    }
    default: {
      submission.value satisfies never;
      return json({ errors: { body: "Invalid action" } }, { status: 400 });
    }
  }
};

export default function Page() {
  const { personalAccessTokens, roles, defaultRoleId } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Personal Access Tokens" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={BookOpenIcon}
            to={docsPath("management/overview#personal-access-token-pat")}
            variant="docs/small"
          >
            Personal Access Token docs
          </LinkButton>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary/small">Create new token…</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>Create a Personal Access Token</DialogHeader>
              <CreatePersonalAccessToken roles={roles} defaultRoleId={defaultRoleId} />
            </DialogContent>
          </Dialog>
        </PageAccessories>
      </NavBar>

      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-1">
          <Table containerClassName="border-t-0">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Token</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Last accessed</TableHeaderCell>
                <TableHeaderCell hiddenLabel>Delete</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {personalAccessTokens.length > 0 ? (
                personalAccessTokens.map((personalAccessToken) => {
                  return (
                    <TableRow key={personalAccessToken.id} className="group">
                      <TableCell>{personalAccessToken.name}</TableCell>
                      <TableCell>{personalAccessToken.obfuscatedToken}</TableCell>
                      <TableCell>
                        <DateTime date={personalAccessToken.createdAt} />
                      </TableCell>
                      <TableCell>
                        {personalAccessToken.lastAccessedAt ? (
                          <DateTime date={personalAccessToken.lastAccessedAt} />
                        ) : (
                          "Never"
                        )}
                      </TableCell>
                      <TableCellMenu
                        isSticky
                        visibleButtons={<RevokePersonalAccessToken token={personalAccessToken} />}
                      />
                    </TableRow>
                  );
                })
              ) : (
                <TableBlankRow colSpan={5}>
                  <Paragraph
                    variant="base/bright"
                    className="flex items-center justify-center py-8"
                  >
                    You have no Personal Access Tokens (that haven't been revoked).
                  </Paragraph>
                </TableBlankRow>
              )}
            </TableBody>
          </Table>
        </div>
      </PageBody>
    </PageContainer>
  );
}

type SystemRole = { id: string; name: string; description: string };

function CreatePersonalAccessToken({
  roles,
  defaultRoleId,
}: {
  roles: SystemRole[];
  defaultRoleId: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data as any;

  const [form, { tokenName }] = useForm({
    id: "create-personal-access-token",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: CreateTokenSchema });
    },
  });

  const token = lastSubmission?.payload?.token
    ? (lastSubmission?.payload?.token as CreatedPersonalAccessToken)
    : undefined;

  // OSS path: rbac.allRoles returns []; we hide the dropdown entirely
  // rather than showing an empty Select. createPersonalAccessToken's
  // roleId is optional, so omitting it produces a working PAT with no
  // explicit role attached (matches pre-RBAC behaviour).
  const showRolePicker = roles.length > 0;
  const [selectedRoleId, setSelectedRoleId] = useState(defaultRoleId);

  return (
    <div className="max-w-full overflow-x-hidden">
      {token ? (
        <div className="flex flex-col gap-2 pt-3">
          <Label>Successfully generated a new token</Label>
          <Callout variant="success">
            Copy this access token and store it in a secure place - you will not be able to see it
            again.
          </Callout>
          <ClipboardField
            secure
            value={token.token}
            variant={"secondary/medium"}
            icon={<ShieldExclamationIcon className="size-5 text-success" />}
            className="mt-3"
          />
        </div>
      ) : (
        <fetcher.Form method="post" {...form.props}>
          <input type="hidden" name="action" value="create" />
          {showRolePicker && <input type="hidden" name="roleId" value={selectedRoleId} />}
          <Fieldset className="mt-3">
            <InputGroup>
              <Label htmlFor={tokenName.id}>Name</Label>
              <Input
                {...conform.input(tokenName, { type: "text" })}
                placeholder="Name your Personal Access Token"
                defaultValue=""
                icon={ShieldCheckIcon}
                autoComplete="off"
              />
              <Hint>
                This will help you to identify your token. Tokens called "cli" are automatically
                generated when you login with our CLI.
              </Hint>
              <FormError id={tokenName.errorId}>{tokenName.error}</FormError>
            </InputGroup>

            {showRolePicker && (
              <InputGroup>
                <Label>Role</Label>
                <Select<string, SystemRole>
                  value={selectedRoleId}
                  setValue={(v) => setSelectedRoleId(v)}
                  items={roles}
                  variant="tertiary/small"
                  dropdownIcon
                  text={(v) => roles.find((r) => r.id === v)?.name ?? "Select a role"}
                >
                  {(items) =>
                    items.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        <span className="flex flex-col">
                          <span>{role.name}</span>
                          {role.description ? (
                            <span className="text-xs text-text-dimmed">{role.description}</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))
                  }
                </Select>
                <Hint>
                  The token's permissions are bound to this role. Defaults to your own role so the
                  token can't do more than you can.
                </Hint>
              </InputGroup>
            )}

            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"}>
                  Create token
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant={"tertiary/small"}>Cancel</Button>
                </DialogClose>
              }
            />
          </Fieldset>
        </fetcher.Form>
      )}
    </div>
  );
}

function RevokePersonalAccessToken({ token }: { token: ObfuscatedPersonalAccessToken }) {
  const lastSubmission = useActionData();

  const [form, { tokenId }] = useForm({
    id: "revoke-personal-access-token",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: CreateTokenSchema });
    },
  });

  return (
    <SimpleTooltip
      button={
        <Dialog>
          <DialogTrigger
            asChild
            className="size-6 rounded-sm p-1 text-error transition hover:bg-charcoal-700"
          >
            <TrashIcon className="size-3" />
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>Revoke Personal Access Token</DialogHeader>
            <div className="flex flex-col gap-3 pt-3">
              <Paragraph className="mb-1">
                Are you sure you want to revoke "{token.name}"? This can't be reversed.
              </Paragraph>
              <FormButtons
                confirmButton={
                  <Form method="post" {...form.props}>
                    <input type="hidden" name="action" value="revoke" />
                    <input type="hidden" name="tokenId" value={token.id} />
                    <Button type="submit" variant="danger/medium">
                      Revoke token
                    </Button>
                  </Form>
                }
                cancelButton={
                  <DialogClose asChild>
                    <Button variant={"tertiary/medium"}>Cancel</Button>
                  </DialogClose>
                }
              />
            </div>
          </DialogContent>
        </Dialog>
      }
      content="Revoke token…"
      side="left"
      disableHoverableContent
    />
  );
}
