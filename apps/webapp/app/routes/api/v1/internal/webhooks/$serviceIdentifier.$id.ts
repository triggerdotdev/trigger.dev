import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findExternalSourceById } from "~/models/externalSource.server";
import { HandleExternalSource } from "~/services/externalSources/handleExternalSource.server";
import { VerifyExternalSource } from "~/services/externalSources/verifyExternalSource.server";

const paramsSchema = z.object({
  id: z.string(),
  serviceIdentifier: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  const { id, serviceIdentifier } = paramsSchema.parse(params);

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
    const service = new VerifyExternalSource();
    const result = await service.call(
      externalSource,
      serviceIdentifier,
      request
    );

    switch (result.status) {
      case "ok": {
        return new Response(result.data, { status: 200 });
      }
      case "ignored": {
        return new Response(result.reason, { status: 200 });
      }
      case "error": {
        return new Response(result.error, { status: 500 });
      }
    }
  } catch (error) {
    return {
      status: 500,
      body:
        error instanceof Error
          ? error.message
          : `Unknown error: ${JSON.stringify(error)}`,
    };
  }
}

export async function action({ request, params }: ActionArgs) {
  const { id, serviceIdentifier } = paramsSchema.parse(params);

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
      body:
        error instanceof Error
          ? error.message
          : `Unknown error: ${JSON.stringify(error)}`,
    };
  }
}
