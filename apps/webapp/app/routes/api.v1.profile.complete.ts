import { json } from "@remix-run/server-runtime";
import { CompleteProfileRequestBody } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionPATApiRoute(
  {
    method: "POST",
    body: CompleteProfileRequestBody,
  },
  async ({ body, authentication }) => {
    if (authentication.userActor) {
      return json(
        {
          error: "Unauthorized",
          code: "unauthorized",
          param: "access_token",
          type: "authorization",
        },
        { status: 403 }
      );
    }

    const result = await prisma.user.updateMany({
      where: {
        id: authentication.userId,
        confirmedBasicDetails: false,
      },
      data: {
        name: body.name,
        confirmedBasicDetails: true,
      },
    });

    return json({ updated: result.count > 0 });
  }
);
