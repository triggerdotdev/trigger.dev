import { Form, useActionData, useFetcher } from "@remix-run/react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { useUser } from "~/hooks/useUser";
import { z } from "zod";
import { ActionFunction, LoaderFunctionArgs, json, redirect } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { parse } from "@conform-to/zod";
import { accountPath, jobPath, jobTestPath, rootPath } from "~/utils/pathBuilder";
import { conform, useForm } from "@conform-to/react";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import { Checkbox } from "~/components/primitives/Checkbox";
import { updateUser } from "~/models/user.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { prisma } from "~/db.server";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { FormTitle } from "~/components/primitives/FormTitle";
import {
  createPersonalAccessToken,
  getValidPersonalAccessTokens,
} from "~/services/personalAccessToken.server";
import { Handle } from "~/utils/handle";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
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
import { Dialog, DialogTrigger, DialogContent } from "@radix-ui/react-dialog";
import { DeleteJobDialogContent } from "~/components/jobs/DeleteJobModalContent";
import { JobStatusBadge } from "~/components/jobs/JobStatusBadge";
import { DateTime } from "~/components/primitives/DateTime";
import { DialogHeader } from "~/components/primitives/Dialog";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { runStatusTitle } from "~/components/runs/RunStatuses";

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
  name: z
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
      name: submission.value.name,
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
    <AppContainer>
      <MainCenteredContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Token</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
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
                    <TableCell>{personalAccessToken.obfuscatedToken}</TableCell>
                    <TableCell>{personalAccessToken.name}</TableCell>
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
                  You have no Personal Access Tokens that aren't revoked.
                </Paragraph>
              </TableBlankRow>
            )}
          </TableBody>
        </Table>
      </MainCenteredContainer>
    </AppContainer>
  );
}

function CreatePersonalAccessToken() {
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data;

  const [form, { name }] = useForm({
    id: "account",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: CreateTokenSchema });
    },
  });

  console.log(lastSubmission);

  return (
    <div>
      <FormTitle LeadingIcon="user" title="Profile" />
      <Form method="post" {...form.props} className="max-w-md">
        <Fieldset>
          <InputGroup>
            <Label htmlFor={name.id}>Name</Label>
            <Input
              {...conform.input(name, { type: "text" })}
              placeholder="The name of your Personal Access Token"
              defaultValue=""
              icon="account"
            />
            <Hint>This is only used in the UI.</Hint>
            <FormError id={name.errorId}>{name.error}</FormError>
          </InputGroup>

          <FormButtons
            confirmButton={
              <Button type="submit" variant={"primary/small"}>
                Update
              </Button>
            }
            cancelButton={
              <LinkButton to={rootPath()} variant={"secondary/small"}>
                Cancel
              </LinkButton>
            }
          />
        </Fieldset>
      </Form>
    </div>
  );
}
