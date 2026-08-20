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
  // A customer with neither an email nor an external id is valid input, not a malformed request:
  // a contact created by an integration can legitimately have neither. There's nothing to look up,
  // so the route answers every key with no data — rejecting it would make Plain record an
  // integration error, which is the failure this schema change exists to remove.
  customer: z.object({
    id: z.string(),
    email: z.string().nullish(),
    externalId: z.string().nullish(),
  }),
  thread: z
    .object({
      id: z.string(),
    })
    .nullish(),
});

/**
 * The values to try, in order, when looking a user up by email.
 *
 * `User.email` is not stored consistently cased: the SSO upsert writes
 * `email.toLowerCase().trim()`, while `findOrCreateMagicLinkUser` and the OAuth paths store
 * whatever the provider gave us. So neither an exact match nor a lowercased one finds everybody —
 * exact misses an SSO user whose address arrives capitalised, lowercased misses a magic-link user
 * stored with capitals.
 *
 * Hence two candidates: the address as sent (trimmed), then its lowercased form. Both are exact
 * matches, so each uses the unique index on `email` — a case-insensitive query would not, and this
 * table is far too big to scan. The common case hits on the first.
 *
 * Empty when there's no usable address, so callers can skip the lookup entirely.
 */
export function emailLookupCandidates(email: string | null | undefined): string[] {
  const asSent = email?.trim();
  if (!asSent) return [];

  const lowercased = asSent.toLowerCase();
  return asSent === lowercased ? [asSent] : [asSent, lowercased];
}

type NoDataCard = { key: string; components: null; timeToLiveSeconds: number };

/**
 * How long Plain may cache a card we had no data for.
 *
 * Explicit rather than omitted: omitting the field falls back to the TTL configured for that card
 * in Plain's settings, so a customer who becomes resolvable — an external id gets set, or someone
 * signs up with that address — would keep showing an empty card for however long that default is.
 * Short enough to recover promptly, long enough not to re-ask on every glance at a thread.
 */
const NO_DATA_TTL_SECONDS = 60;

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
          timeToLiveSeconds: NO_DATA_TTL_SECONDS,
        })
      ),
  ];
}
