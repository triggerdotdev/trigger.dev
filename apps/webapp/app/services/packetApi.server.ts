import { json } from "@remix-run/server-runtime";
import type { RbacResource, RbacSubject } from "@trigger.dev/plugins";
import { z } from "zod";
import type { ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { anyResource, createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  formatStorageUri,
  generatePresignedUrl,
  isPacketPathUnder,
  jsonPacketPresignFailure,
  parseStorageUri,
} from "~/v3/objectStore.server";

export const STORED_PAYLOAD_FORBIDDEN_ERROR =
  "Stored payloads require an unrestricted private API key or a payload this credential uploaded";

/**
 * Object-store prefix a scoped credential's packet uploads (offloaded trigger payloads and task
 * outputs alike) land under, so a pointer proves who uploaded it. Unrestricted credentials upload
 * wherever they ask and get undefined.
 */
function scopedPacketNamespace(subject: RbacSubject): string | undefined {
  if (subject.type === "runToken") return `uploads/run/${subject.runId}`;
  if (subject.type === "apiKey" && subject.restricted) return `uploads/key/${subject.apiKeyId}`;
  return undefined;
}

/**
 * Which stored-payload pointers a credential may submit when triggering. A scoped credential
 * (run token, restricted key) may only reference its own uploads, so it cannot create a run
 * that reads another run's payload or output, nor replay a pointer it learned elsewhere.
 */
export function storedPayloadPointerPolicy(subject: RbacSubject): (pointer: unknown) => boolean {
  if (subject.type === "publicJWT") return () => false;
  const namespace = scopedPacketNamespace(subject);
  if (!namespace) return () => true;
  return (pointer) => isPacketPathUnder(pointer, namespace);
}

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

export function packetUploadResources(filename: string): RbacResource[] {
  const resources: RbacResource[] = [{ type: "packets" }];
  const { path } = parseStorageUri(filename);
  const output = /^(run_[A-Za-z0-9_-]+)-[1-9]\d*\/output\.[a-z0-9]+$/.exec(path);
  if (output && output[0] === path) {
    resources.push({ type: "runs", id: output[1] });
  }
  return resources;
}

export function createPacketUploadRoute({ forceNoPrefix = false } = {}) {
  return createActionApiRoute(
    {
      params: PacketParamsSchema,
      method: "PUT",
      authorization: {
        action: "write",
        resource: (params) => anyResource(packetUploadResources(params["*"])),
      },
    },
    async ({ params, authentication, subject }) => {
      assertPacketNamespaceAccess(authentication);
      const { protocol, path } = parseStorageUri(params["*"]);
      const namespace = scopedPacketNamespace(subject);
      // The legacy route returns no storagePath, so a relocated upload could never be referenced.
      if (forceNoPrefix && namespace) {
        return json(
          { error: "Scoped credentials must upload packets via /api/v2/packets; upgrade the SDK" },
          { status: 400 }
        );
      }
      const filename = formatStorageUri(namespace ? `${namespace}/${path}` : path, protocol);
      const signed = await generatePresignedUrl(
        authentication.environment.project.externalRef,
        authentication.environment.slug,
        filename,
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
