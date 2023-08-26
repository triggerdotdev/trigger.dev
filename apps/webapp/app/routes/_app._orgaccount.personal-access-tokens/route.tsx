import { Form, useFetcher } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { FormButtons } from "~/components/primitives/FormButtons";
import { ActionFunction, json } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { personalAccessTokensPath } from "~/utils/pathBuilder";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { prisma } from "~/db.server";
import { customAlphabet } from "nanoid";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { DateTime } from "~/components/primitives/DateTime";
import { Badge } from "~/components/primitives/Badge";
import { cn } from "~/utils/cn";

export const loader = async ({ request }: { request: Request }) => {
  const userid = await requireUserId(request);
  const tokens = await prisma.personalAccessToken.findMany({
    where: {
      userId: userid,
    },
  });
  return typedjson({ tokens });
};

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);
  try {
    const apiKeyId = customAlphabet(
      "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      12
    );

    const personalAccessToken = `tr_pat_${apiKeyId(20)}`;

    await prisma.personalAccessToken.create({
      data: {
        token: personalAccessToken,
        userId: userId,
      },
    });

    return redirectWithSuccessMessage(
      personalAccessTokensPath(),
      request,
      "Personal Token Access Generated."
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { tokens } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const isLoading =
    fetcher.state === "submitting" ||
    (fetcher.state === "loading" && fetcher.formMethod === "DELETE");

  const badgeClass =
    "py-1 px-1.5 text-xs font-normal inline-flex items-center justify-center whitespace-nowrap rounded-sm";

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Personal Access Tokens" />
        </PageTitleRow>
        <PageDescription>Manage your Personal Access Tokens.</PageDescription>
      </PageHeader>
      <PageBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Token</TableHeaderCell>
              <TableHeaderCell>Last accessed at</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length > 0 &&
              tokens.map((token) => {
                return (
                  <TableRow>
                    <TableCell>
                      <ClipboardField
                        className="w-full max-w-none"
                        secure
                        value={token.token}
                        variant={"primary/medium"}
                      />
                    </TableCell>
                    <TableCell>
                      {token.lastAccessedAt ? (
                        <DateTime date={token.lastAccessedAt} />
                      ) : (
                        "Not used yet"
                      )}
                    </TableCell>
                    <TableCell>
                      {token.revokedAt === null ? (
                        <Badge className={cn(badgeClass, "bg-slate-800 text-green-500")}>
                          <span>Active</span>
                        </Badge>
                      ) : (
                        <Badge className={cn(badgeClass, "bg-rose-600 text-white")}>
                          <span>Revoked</span>
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <fetcher.Form method="delete" action={`/personal-access-tokens/${token.id}`}>
                        <Button
                          variant="danger/large"
                          fullWidth
                          disabled={token.revokedAt !== null}
                        >
                          {isLoading ? (
                            <Spinner />
                          ) : (
                            <>
                              <NamedIcon
                                name="close"
                                className="mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"
                              />
                              Revoke
                            </>
                          )}
                        </Button>
                      </fetcher.Form>
                    </TableCell>
                  </TableRow>
                );
              })}
            {tokens.length === 0 && <h1>You have no generatde tokens</h1>}
          </TableBody>
        </Table>

        <div className="my-4 flex w-full justify-end">
          <Form method="post" className="max-w-md">
            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/large"}>
                  Generate Token
                </Button>
              }
            />
          </Form>
        </div>
      </PageBody>
    </PageContainer>
  );
}
