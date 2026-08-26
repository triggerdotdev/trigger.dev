import { describe, expect, it } from "vitest";
import { resolveInheritedMintKind } from "~/v3/runOpsMigration/resolveInheritedMintKind.server";
import { mintFriendlyIdForKind } from "~/v3/runOpsMigration/mintAnchoredRunFriendlyId.server";

// The shape both trigger services must produce for a child of a gen-2 parent. Before this
// change triggerFailedTask duplicated the branch inline and minted gen-1, which put a child
// on a different database from its parent.
const GEN2_PARENT = `run_${"a".repeat(24)}a2`;

describe("a failed child of a gen-2 parent", () => {
  it("mints onto the parent's shard", () => {
    const body = mintFriendlyIdForKind(resolveInheritedMintKind(GEN2_PARENT)).slice(4);
    expect(body[24]).toBe("a");
    expect(body[25]).toBe("2");
  });
});
