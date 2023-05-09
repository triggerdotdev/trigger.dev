import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  connectionId: z.string(),
});

// PUT /resources/sources/:sourceId
/** This is used to connect an external source with a connection to an API */
export async function action({ request, params }: ActionArgs) {
  await requireUserId(request);

  const { sourceId } = params;
  invariant(sourceId, "sourceId is required");

  // first make sure this is a PUT request
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const formObject = Object.fromEntries(formData.entries());
    const { connectionId } = requestSchema.parse(formObject);
    // TODO: implement this
    // await connectExternalSource({ sourceId, connectionId });

    return typedjson({ success: true });
  } catch (error: any) {
    console.error(error);
    return typedjson({ error: error.message }, { status: 400 });
  }
}
