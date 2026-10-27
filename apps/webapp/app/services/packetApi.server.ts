import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import type { ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl, jsonPacketPresignFailure } from "~/v3/objectStore.server";

export const PacketParamsSchema = z.object({
  "*": z.string(),
});

export function assertPacketNamespaceAccess(authentication: ApiAuthenticationResultSuccess): void {
  // ponytail: dev members share packet namespaces. Scoped raw access needs environment-ID
  // storage namespaces before development run-token support can be enabled.
  if (
    authentication.environment.type === "DEVELOPMENT" &&
    (authentication.type !== "PRIVATE" || authentication.environmentScoped)
  ) {
    throw json(
      { error: "Raw development packets require an unrestricted API key." },
      { status: 403 }
    );
  }
}

export function createPacketUploadRoute({ forceNoPrefix = false } = {}) {
  return createActionApiRoute(
    {
      params: PacketParamsSchema,
      method: "PUT",
      authorization: {
        action: "write",
        resource: () => ({ type: "packets" }),
      },
    },
    async ({ params, authentication }) => {
      assertPacketNamespaceAccess(authentication);
      const signed = await generatePresignedUrl(
        authentication.environment.project.externalRef,
        authentication.environment.slug,
        params["*"],
        "PUT",
        { forceNoPrefix }
      );

      if (!signed.success) {
        return jsonPacketPresignFailure(signed);
      }

      if (!forceNoPrefix && signed.storagePath === undefined) {
        return json({ error: "Failed to resolve storage path for packet upload" }, { status: 500 });
      }

      return json(
        forceNoPrefix
          ? { presignedUrl: signed.url }
          : { presignedUrl: signed.url, storagePath: signed.storagePath }
      );
    }
  );
}
