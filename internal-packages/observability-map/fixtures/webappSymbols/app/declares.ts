// webappSymbols.test.ts's self-test tree. One name per declaration form, never two forms of the same
// name: a single `has` assertion cannot say which branch of the walker answered it, so a shared name
// would let a branch be deleted with the fixture test still green. `helper` covers the function
// declaration, `createJWT` the local, `mintSessionToken` the member. `signJWT` is read and declared
// nowhere, so a walker that collected references as declarations would find it.
export function helper(kind: string): boolean {
  const createJWT = kind === "jwt";
  return createJWT;
}

export const api = {
  mintSessionToken: false,
};

export function reads(payload: Record<string, unknown>): unknown {
  return payload.signJWT;
}
