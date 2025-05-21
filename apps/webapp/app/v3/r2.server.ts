import { AwsClient } from "aws4fetch";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { startActiveSpan } from "./tracer.server";
import { IOPacket } from "@trigger.dev/core/v3";

export const r2 = singleton("r2", initializeR2);

function initializeR2() {
  if (!env.OBJECT_STORE_ACCESS_KEY_ID || !env.OBJECT_STORE_SECRET_ACCESS_KEY) {
    return;
  }

  return new AwsClient({
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY,
  });
}

export async function uploadPacketToObjectStore(
  filename: string,
  data: ReadableStream | string,
  contentType: string,
  environment: AuthenticatedEnvironment
): Promise<string> {
  return await startActiveSpan("uploadPacketToObjectStore()", async (span) => {
    if (!r2) {
      throw new Error("Object store credentials are not set");
    }

    if (!env.OBJECT_STORE_BASE_URL) {
      throw new Error("Object store base URL is not set");
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename: filename,
    });

    const url = new URL(env.OBJECT_STORE_BASE_URL);
    url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${filename}`;

    logger.debug("Uploading to object store", { url: url.href });

    const response = await r2.fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload output to ${url}: ${response.statusText}`);
    }

    return url.href;
  });
}

export async function downloadPacketFromObjectStore(
  packet: IOPacket,
  environment: AuthenticatedEnvironment
): Promise<IOPacket> {
  if (packet.dataType !== "application/store") {
    return packet;
  }

  return await startActiveSpan("downloadPacketFromObjectStore()", async (span) => {
    if (!r2) {
      throw new Error("Object store credentials are not set");
    }

    if (!env.OBJECT_STORE_BASE_URL) {
      throw new Error("Object store base URL is not set");
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename: packet.data,
    });

    const url = new URL(env.OBJECT_STORE_BASE_URL);
    url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${packet.data}`;

    logger.debug("Downloading from object store", { url: url.href });

    const response = await r2.fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to download input from ${url}: ${response.statusText}`);
    }

    const data = await response.text();

    const rawPacket = {
      data,
      dataType: "application/json",
    };

    return rawPacket;
  });
}

export async function uploadDataToObjectStore(
  filename: string,
  data: string,
  contentType: string,
  prefix?: string
): Promise<string> {
  return await startActiveSpan("uploadDataToObjectStore()", async (span) => {
    if (!r2) {
      throw new Error("Object store credentials are not set");
    }

    if (!env.OBJECT_STORE_BASE_URL) {
      throw new Error("Object store base URL is not set");
    }

    span.setAttributes({
      prefix,
      filename,
    });

    const url = new URL(env.OBJECT_STORE_BASE_URL);
    url.pathname = `${prefix}/${filename}`;

    logger.debug("Uploading to object store", { url: url.href });

    const response = await r2.fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload data to ${url}: ${response.statusText}`);
    }

    return url.href;
  });
}

export async function generatePresignedRequest(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT"
): Promise<
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      request: Request;
    }
> {
  if (!env.OBJECT_STORE_BASE_URL) {
    return {
      success: false,
      error: "Object store base URL is not set",
    };
  }

  if (!r2) {
    return {
      success: false,
      error: "Object store client is not initialized",
    };
  }

  const url = new URL(env.OBJECT_STORE_BASE_URL);
  url.pathname = `/packets/${projectRef}/${envSlug}/${filename}`;
  url.searchParams.set("X-Amz-Expires", "300"); // 5 minutes

  const signed = await r2.sign(
    new Request(url, {
      method,
    }),
    {
      aws: { signQuery: true },
    }
  );

  logger.debug("Generated presigned URL", {
    url: signed.url,
    headers: Object.fromEntries(signed.headers),
    projectRef,
    envSlug,
    filename,
  });

  return {
    success: true,
    request: signed,
  };
}

export async function generatePresignedUrl(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT"
): Promise<
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      url: string;
    }
> {
  const signed = await generatePresignedRequest(projectRef, envSlug, filename, method);

  if (!signed.success) {
    return {
      success: false,
      error: signed.error,
    };
  }

  signed;

  return {
    success: true,
    url: signed.request.url,
  };
}
