import { ActionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { jsonWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";

export async function action({ request }: ActionArgs) {
  const userId = await requireUserId(request);

  const user = await prisma.user.update({
    where: { id: userId },
    data: { isOnCloudWaitlist: true },
  });

  return jsonWithSuccessMessage(
    user,
    request,
    "We'll let you know when it's ready!"
  );
}
