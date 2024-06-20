import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { apiCors } from "~/utils/apiCors";
import { getTimezones } from "~/utils/timezones.server";

const SearchParamsSchema = z.object({
  excludeUtc: z.preprocess((value) => value === "true", z.boolean()).default(false),
});

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const rawSearchParams = new URL(request.url).searchParams;
  const params = SearchParamsSchema.safeParse(Object.fromEntries(rawSearchParams.entries()));

  if (!params.success) {
    return apiCors(
      request,
      json({ error: "Invalid request parameters", issues: params.error.issues }, { status: 400 })
    );
  }

  const timezones = getTimezones(!params.data.excludeUtc);
  return apiCors(request, json({ timezones }));
}
