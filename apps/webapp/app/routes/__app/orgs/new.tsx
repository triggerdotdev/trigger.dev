import { BookmarkIcon } from "@heroicons/react/24/outline";
import type { ActionFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import * as React from "react";
import { PrimaryButton, SecondaryLink } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/text/Headers";
import { createOrganization } from "~/models/organization.server";
import { requireUserId } from "~/services/session.server";

type ActionData = {
  errors?: {
    title?: string;
    body?: string;
  };
};

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const title = formData.get("title");
  if (typeof title !== "string" || title.length === 0) {
    return json<ActionData>(
      { errors: { title: "A Organization title is required." } },
      { status: 400 }
    );
  }

  try {
    const organization = await createOrganization({ title, userId });
    return redirect(`/orgs/${organization.slug}`);
  } catch (error: any) {
    return json<ActionData>(
      { errors: { body: error.message } },
      { status: 400 }
    );
  }
};

export default function NewOrganizationPage() {
  const actionData = useActionData() as ActionData;
  const titleRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (actionData?.errors?.title) {
      titleRef.current?.focus();
    }
  }, [actionData]);

  return (
    <main className="w-full h-full flex items-center justify-center">
      <div className="flex flex-col gap-y-3.5 min-w-[400px] bg-slate-800 border border-slate-800 rounded-md p-10 shadow-md">
        <Header1 size="large" className="">
          Create a new Organization
        </Header1>
        <Form
          method="post"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: "100%",
          }}
        >
          <div className="flex flex-col gap-4 mb-3">
            <div className="flex w-full flex-col gap-1">
              <label className="text-slate-500 text-sm">
                Name your Organization
              </label>
              <div className="group flex">
                <div className="flex justify-end pointer-events-none z-10 -mr-8 items-center w-8">
                  <BookmarkIcon className="h-5 w-5 text-slate-600" />
                </div>
                <input
                  ref={titleRef}
                  name="title"
                  autoFocus
                  placeholder="e.g. Company name"
                  className="relative w-full pl-10 pr-3 py-2 rounded bg-slate-850 group-focus:border-indigo-500 placeholder:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-invalid={actionData?.errors?.title ? true : undefined}
                  aria-errormessage={
                    actionData?.errors?.title ? "title-error" : undefined
                  }
                />
              </div>
            </div>
            {actionData?.errors?.title && (
              <div className="pt-1 text-red-700" id="title-error">
                {actionData.errors.title}
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <SecondaryLink to="/" className="rounded py-2 px-4">
              Cancel
            </SecondaryLink>
            <PrimaryButton type="submit" className="rounded py-2 px-4">
              Create Organization
            </PrimaryButton>
          </div>
        </Form>
      </div>
    </main>
  );
}
