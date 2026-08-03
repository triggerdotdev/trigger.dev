// SCORER TEST FIXTURE. A throwaway route used to verify that the observability-map CI
// comment reports a regression when an unguarded sensitive route is added. Never merge.
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";

export async function action({ params }: { params: { orgParam: string } }) {
  const org = await prisma.organization.findFirst({ where: { slug: params.orgParam } });
  const projects = await prisma.project.findMany({ where: { organizationId: org?.id } });
  return json({ count: projects.length });
}
