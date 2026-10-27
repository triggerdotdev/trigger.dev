import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { confirmEmailChange, previewEmailChange } from "~/services/emailChange.server";
import { emailChangeConfirmationCookie } from "~/services/emailChangeConfirmationCookie.server";
import { getUserId } from "~/services/session.server";
import { accountPath } from "~/utils/pathBuilder";

/**
 * Target of the link emailed to a pending address. Works logged out: sending
 * the visitor through /login first would invite them to "log in" with the new
 * address, which would register it as a separate account.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.has("token")) {
    const token = url.searchParams.get("token") ?? "";
    const preview = await previewEmailChange(token);
    return redirect(url.pathname, {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": await emailChangeConfirmationCookie.serialize(
          preview ? token : "",
          preview ? {} : { maxAge: 0 }
        ),
      },
    });
  }

  const cookie: unknown = await emailChangeConfirmationCookie.parse(request.headers.get("Cookie"));
  const token = typeof cookie === "string" ? cookie : "";
  const preview = await previewEmailChange(token);
  return json(preview ? { token, email: preview.email } : { token: "", email: null }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const formData = await request.formData();
  const token = formData.get("token");
  const result = await confirmEmailChange(typeof token === "string" ? token : "");

  const sessionUserId = await getUserId(request);
  const destination = sessionUserId ? accountPath() : "/login";

  if (!result.ok) {
    return redirectWithErrorMessage(destination, request, result.error);
  }

  return redirectWithSuccessMessage(
    destination,
    request,
    sessionUserId === result.userId
      ? "Your email address has been updated."
      : `Your email address is now ${result.email}. Use it to log in.`
  );
}

export default function ConfirmEmailChangePage() {
  const { token, email } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <LoginPageLayout>
      <div className="space-y-6">
        <Header1>Confirm your email change</Header1>
        {email ? (
          <>
            <Paragraph>
              Confirm that you want to use <strong>{email}</strong> for your account. If you didn’t
              request this change, close this page.
            </Paragraph>
            <Form method="post">
              <input type="hidden" name="token" value={token} />
              <Button type="submit" variant="primary/medium" disabled={navigation.state !== "idle"}>
                Confirm email change
              </Button>
            </Form>
          </>
        ) : (
          <Paragraph>
            This confirmation link is invalid or has expired. Request a new one.
          </Paragraph>
        )}
      </div>
    </LoginPageLayout>
  );
}
