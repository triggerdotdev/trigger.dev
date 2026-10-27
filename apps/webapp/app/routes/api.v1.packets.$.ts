import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { isPublicJWT } from "@trigger.dev/core/v3/jwt";
import type { ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { authenticateBearerWithTelemetry } from "~/services/authTelemetry.server";
import { logger } from "~/services/logger.server";
import { apiCors } from "~/utils/apiCors";
import {
  assertPacketNamespaceAccess,
  createPacketUploadRoute,
  PacketParamsSchema,
} from "~/services/packetApi.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl, jsonPacketPresignFailure } from "~/v3/objectStore.server";

const { action } = createPacketUploadRoute({ forceNoPrefix: true });
export { action };

const scopedLoader = createLoaderApiRoute(
  {
    params: PacketParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => ({ type: "packets" }),
    authorization: {
      action: "read",
      resource: (packets) => packets,
    },
  },
  async ({ params, authentication }) => {
    assertPacketNamespaceAccess(authentication);
    return downloadPacket(authentication, params["*"]);
  }
);

async function downloadPacket(authentication: ApiAuthenticationResultSuccess, filename: string) {
  const signed = await generatePresignedUrl(
    authentication.environment.project.externalRef,
    authentication.environment.slug,
    filename,
    "GET"
  );
  return signed.success ? json({ presignedUrl: signed.url }) : jsonPacketPresignFailure(signed);
}

export async function loader(args: LoaderFunctionArgs) {
  const { request, params } = args;
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  if (request.method === "OPTIONS" || !bearer || !isPublicJWT(bearer)) {
    return scopedLoader(args);
  }

  // ponytail: legacy public-JWT GET remains in every environment, including DEVELOPMENT's shared
  // packet namespace, until the SEC-762 diagnostic log drains. Other credentials use packet abilities.
  try {
    const result = await authenticateBearerWithTelemetry(request, { allowJWT: true });
    if (!result.ok) {
      return apiCors(request, json({ error: result.error }, { status: result.status }));
    }
    if (result.subject.type !== "publicJWT") {
      return apiCors(request, json({ error: "Invalid Public Access Token" }, { status: 401 }));
    }
    const authentication: ApiAuthenticationResultSuccess = {
      ok: true,
      apiKey: result.environment.apiKey,
      type: "PUBLIC_JWT",
      environmentScoped: true,
      credentialKind: result.resolution.credentialKind,
      environment: result.environment,
    };
    const parsed = PacketParamsSchema.safeParse(params);
    if (!parsed.success) {
      return apiCors(request, json({ error: "Params Error" }, { status: 400 }));
    }
    logger.info("Legacy packet download with public token", {
      environmentId: authentication.environment.id,
      projectId: authentication.environment.projectId,
      environmentType: authentication.environment.type,
    });
    return apiCors(request, await downloadPacket(authentication, parsed.data["*"]));
  } catch (error) {
    if (error instanceof Response) return apiCors(request, error);
    throw error;
  }
}
