export type KnownUser = { userId: string; apiUrl: string };

let knownUser: KnownUser | undefined;
let generation = 0;
let waiters: Array<(user: KnownUser) => void> = [];

// Set by every login check that already talked to the API, so analytics never needs its own call.
// apiUrl is the server that answered; analytics sends only for the Cloud one.
// A lookup that began before forgetKnownUser() passes its generation and is then ignored.
export function rememberUserId(userId: string, apiUrl: string, lookupGeneration = generation) {
  if (lookupGeneration !== generation) return;
  knownUser = { userId, apiUrl };
  const ready = waiters;
  waiters = [];
  for (const resolve of ready) resolve(knownUser);
}

export function getKnownUser() {
  return knownUser;
}

export function knownUserGeneration() {
  return generation;
}

export function forgetKnownUser() {
  generation += 1;
  knownUser = undefined;
}

// Pending until a login check succeeds, which may be never.
export function waitForUser(): Promise<KnownUser | undefined> {
  if (knownUser) return Promise.resolve(knownUser);
  return new Promise((resolve) => waiters.push(resolve));
}
