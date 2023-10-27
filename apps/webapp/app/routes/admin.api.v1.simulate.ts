import { ActionFunctionArgs, json, redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";

export async function action({ request }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const adminOrgMembers = await prisma.orgMember.findMany({
    where: {
      organizationId: authenticationResult.environment.organizationId,
      user: {
        admin: true,
      },
    },
  });

  if (!adminOrgMembers.length) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  const body: any = await request.json();

  await workerQueue.enqueue("simulate", {
    seconds: body.seconds,
  });

  return json({ success: true });
}
