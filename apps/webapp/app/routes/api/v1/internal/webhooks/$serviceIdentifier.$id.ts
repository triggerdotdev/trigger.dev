import type { ActionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findExternalSourceById } from "~/models/externalSource.server";
import { HandleExternalSource } from "~/services/externalSources/handleExternalSource.server";

export async function action({ request, params }: ActionArgs) {
  const { id, serviceIdentifier } = z
    .object({ id: z.string(), serviceIdentifier: z.string() })
    .parse(params);

  const externalSource = await findExternalSourceById(id);

  if (!externalSource) {
    return {
      status: 404,
      body: `Could not find external source with id ${id} and serviceIdentifier ${serviceIdentifier}`,
    };
  }

  if (
    !externalSource.manualRegistration &&
    externalSource.connection?.apiIdentifier !== serviceIdentifier
  ) {
    return { status: 500, body: "Service identifier does not match" };
  }

  try {
    const service = new HandleExternalSource();

    await service.call(externalSource, serviceIdentifier, request);

    return { status: 200 };
  } catch (error) {
    return {
      status: 500,
      body: error instanceof Error ? error.message : `Unknown error: ${error}`,
    };
  }
}
