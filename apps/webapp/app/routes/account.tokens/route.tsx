import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import { ActionFunction, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { PageHeader, PageTitle, PageTitleRow } from "~/components/primitives/PageHeader";
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
import {
  createPersonalAccessToken,
  getValidPersonalAccessTokens,
} from "~/services/personalAccessToken.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { rootPath } from "~/utils/pathBuilder";

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

const CreateTokenSchema = z.object({
  tokenName: z
    .string({ required_error: "You must enter a name" })
    .min(2, "Your name must be at least 2 characters long")
    .max(50),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const submission = await parse(formData, { schema: CreateTokenSchema, async: true });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const tokenResult = await createPersonalAccessToken({
      name: submission.value.tokenName,
      userId,
    });

    return json({ token: tokenResult });
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
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
        </PageTitleRow>
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

                      <TableCellMenu isSticky>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="small-menu-item"
                              LeadingIcon="trash-can"
                              className="text-xs"
                            >
                              Delete Personal Access Token
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>Delete Personal Access Token</DialogHeader>
                            {/* <DeleteJobDialogContent
                              id={job.id}
                              title={job.title}
                              slug={job.slug}
                              environments={job.environments}
                            /> */}
                          </DialogContent>
                        </Dialog>
                      </TableCellMenu>
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
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary/medium">Create a Personal Access Token</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>Create a Personal Access Token</DialogHeader>
              <CreatePersonalAccessToken />
            </DialogContent>
          </Dialog>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function CreatePersonalAccessToken() {
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data;

  const [form, { tokenName }] = useForm({
    id: "create-personal-access-token",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: CreateTokenSchema });
    },
  });

  console.log(lastSubmission);

  return (
    <div>
      <Form method="post" {...form.props} className="max-w-md">
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
              generated by our CLI.
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
      </Form>
    </div>
  );
}
