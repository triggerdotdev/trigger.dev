import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { ShieldExclamationIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useFetcher } from "@remix-run/react";
import { ActionFunction, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { redirectWithSuccessMessage } from "~/models/message.server";
import {
  CreatedPersonalAccessToken,
  ObfuscatedPersonalAccessToken,
  createPersonalAccessToken,
  getValidPersonalAccessTokens,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { personalAccessTokensPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  try {
    const personalAccessTokens = await getValidPersonalAccessTokens(userId);

    return typedjson({
      personalAccessTokens,
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
        });

        return json({ ...submission, payload: { token: tokenResult } });
      } catch (error: any) {
        return json({ errors: { body: error.message } }, { status: 400 });
      }
    }
    case "revoke": {
      try {
        await revokePersonalAccessToken(submission.value.tokenId);

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
      return json({ errors: { body: "Invalid action" } }, { status: 400 });
    }
  }
};

export const handle: Handle = {
  breadcrumb: (match) => {
    return <BreadcrumbLink to={match.pathname} title={"Personal Access Tokens"} />;
  },
};

export default function Page() {
  const { personalAccessTokens } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Personal Access Tokens" />
          <PageButtons>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="primary/small">Create new token</Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>Create a Personal Access Token</DialogHeader>
                <CreatePersonalAccessToken />
              </DialogContent>
            </Dialog>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>Personal Access Tokens can be used with our CLI and API.</PageDescription>
      </PageHeader>

      <PageBody>
        <div className="flex flex-col gap-3">
          <Table>
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
                      <TableCell alignment="right">
                        <RevokePersonalAccessToken token={personalAccessToken} />
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableBlankRow colSpan={5}>
                  <Paragraph variant="small" className="flex items-center justify-center">
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

function CreatePersonalAccessToken() {
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

  return (
    <div className="max-w-full overflow-x-hidden">
      {token ? (
        <div className="flex flex-col gap-2 p-2">
          <Header2>Successfully generated a new token</Header2>
          <Callout variant="success">
            Do copy this access token and store it in a secure place - you will not be able to see
            it again.
          </Callout>
          <ClipboardField
            secure
            value={token.token}
            variant={"secondary/medium"}
            icon={<ShieldExclamationIcon className="h-5 w-5 text-emerald-500" />}
          />
        </div>
      ) : (
        <fetcher.Form method="post" {...form.props}>
          <input type="hidden" name="action" value="create" />
          <Fieldset>
            <InputGroup>
              <Label htmlFor={tokenName.id}>Name</Label>
              <Input
                {...conform.input(tokenName, { type: "text" })}
                placeholder="The name of your Personal Access Token"
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

            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"}>
                  Update
                </Button>
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
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="small-menu-item" LeadingIcon="trash-can" className="text-xs" />
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Revoke Personal Access Token</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            Are you sure you want to revoke "{token.name}"? This can't be reversed.
          </Paragraph>
          <Form method="post" {...form.props}>
            <input type="hidden" name="action" value="revoke" />
            <input type="hidden" name="tokenId" value={token.id} />
            <Button type="submit" variant="danger/medium" fullWidth>
              Revoke token
            </Button>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
