import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

// A type-level test, not a runtime one: `.test.ts` is excluded from `tsconfig.check.json`, so this
// file is named `.types.ts` to be checked by `pnpm run typecheck --filter webapp`.
//
// `identityOnly` waives the refusal an environment-scoped user-actor token gets on a route that
// names nothing to check its claim against. It is only sound for reads, so the action builder must
// not accept it.

export const identityOnlyLoader = createLoaderPATApiRoute({ identityOnly: true }, async () =>
  json({ ok: true })
);

export const identityOnlyAction = createActionPATApiRoute(
  {
    method: "POST",
    params: z.object({ id: z.string() }),
    // @ts-expect-error — an action mutates, so it can never be identity-only.
    identityOnly: true,
  },
  async () => json({ ok: true })
);
