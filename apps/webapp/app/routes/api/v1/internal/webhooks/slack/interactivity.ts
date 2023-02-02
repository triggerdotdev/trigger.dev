import type { ActionArgs } from "@remix-run/server-runtime";
import { HandleSlackInteractivity } from "~/services/slack/handleInteractivity.server";

export async function action({ request }: ActionArgs) {
  const formData = await request.formData();

  const payload = formData.get("payload");

  if (typeof payload !== "string") {
    return { status: 400 };
  }

  const parsedPayload = JSON.parse(payload);

  const service = new HandleSlackInteractivity();

  try {
    return await service.call(parsedPayload);
  } catch (error) {
    console.error(error);

    return new Response(
      error instanceof Error ? error.message : "Unknown error",
      { status: 500 }
    );
  }
}
