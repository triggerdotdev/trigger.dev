import { z } from "zod";

/**
 * The request Plain sends to a customer card endpoint.
 *
 * `email`, `externalId` and `thread` are nullish rather than optional because Plain sends these
 * keys as explicit nulls rather than omitting them — `externalId` whenever the customer was
 * created outside our own writes (its Slack integration, for one), `thread` when the card is
 * loaded on the customer page rather than in a thread. `.optional()` accepts `undefined` but
 * rejects `null`, which failed the whole request before any lookup could run.
 */
export const PlainCustomerCardRequestSchema = z.object({
  cardKeys: z.array(z.string()),
  customer: z
    .object({
      id: z.string(),
      email: z.string().nullish(),
      externalId: z.string().nullish(),
    })
    .refine((data) => data.email || data.externalId, {
      message: "Either customer.email or customer.externalId must be provided",
      path: ["customer"],
    }),
  thread: z
    .object({
      id: z.string(),
    })
    .nullish(),
});

export type PlainCustomerCardRequest = z.infer<typeof PlainCustomerCardRequestSchema>;

/**
 * An email in the form `User.email` is stored in.
 *
 * Users are written with `email.toLowerCase().trim()` (see `createUser` / SSO upsert in
 * `models/user.server.ts`), and `User.email` is unique, so an exact lookup on whatever Plain sends
 * would miss a real account whenever the address arrives with different casing or padding — which
 * it can, because for customers created outside our own writes it comes from a sender address.
 *
 * Returns null for an address with nothing left after trimming, so callers can skip the lookup.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  return email?.toLowerCase().trim() || null;
}

type NoDataCard = { key: string; components: null };

/**
 * Fills in a `components: null` card for every requested key that wasn't answered.
 *
 * Plain records an integration error against any key it asked for and didn't get back, so a
 * partial response surfaces in the support app as a broken card. `components: null` is how you
 * say "this card has no data" and have Plain hide it instead.
 */
export function answerAllCardKeys<TCard extends { key: string }>(
  cardKeys: string[],
  cards: TCard[]
): (TCard | NoDataCard)[] {
  const answered = new Set(cards.map((card) => card.key));

  return [
    ...cards,
    ...cardKeys
      .filter((key) => !answered.has(key))
      .map(
        (key): NoDataCard => ({
          key,
          components: null,
        })
      ),
  ];
}
