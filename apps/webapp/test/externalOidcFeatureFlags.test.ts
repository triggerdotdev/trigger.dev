import { expect, it } from "vitest";
import { resolveExternalOidcFlags } from "~/services/oidc/externalOidcFeatureFlags";

// Catches: an invalid sibling flag discarding an explicit OIDC authorization override.
it.each([
  { global: true, override: false },
  { global: false, override: true },
  { global: undefined, override: true },
])(
  "preserves org OIDC $override over global $global despite an invalid sibling",
  ({ global, override }) => {
    expect(
      resolveExternalOidcFlags(
        { externalOidc: global },
        { externalOidc: override, realtimeBackend: "not-a-backend" }
      )
    ).toEqual({ externalOidc: override });
  }
);

it.each([
  { global: true, expected: true },
  { global: undefined, expected: false },
])("falls back to global $global for an invalid org OIDC value", ({ global, expected }) => {
  expect(
    resolveExternalOidcFlags({ externalOidc: global }, { externalOidc: "not-a-boolean" })
  ).toEqual({ externalOidc: expected });
});
