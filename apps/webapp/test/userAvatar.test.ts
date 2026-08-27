import { describe, expect, it } from "vitest";
import {
  buildUserAvatarFilename,
  buildUserAvatarUrl,
  isAvatarUploadRejection,
  parseAvatarUpload,
  resolveUserAvatarObjectPath,
} from "~/services/userAvatar.server";
import { MAX_AVATAR_SIZE_IN_BYTES } from "~/utils/avatarLimits";

const USER_ID = "clzabc123";

function filenameFor(bytes: number[]) {
  return buildUserAvatarFilename("image/png", new Uint8Array(bytes));
}

describe("resolveUserAvatarObjectPath", () => {
  it("accepts a content-addressed filename", () => {
    const filename = filenameFor([1, 2, 3]);

    expect(resolveUserAvatarObjectPath(USER_ID, filename)).toBe(`avatars/${USER_ID}/${filename}`);
  });

  it.each([
    ["traversal in the filename", USER_ID, ".."],
    ["encoded traversal in the filename", USER_ID, "%2e%2e"],
    ["traversal in the user id", "..", filenameFor([1])],
    ["encoded traversal in the user id", "%2e%2e", filenameFor([1])],
    ["a disallowed extension", USER_ID, `${"a".repeat(32)}.svg`],
    ["a nested filename", USER_ID, "a/b"],
    ["a nested user id", `${USER_ID}/other`, filenameFor([1])],
    ["a non-hex filename", USER_ID, "not-a-hash.png"],
    ["an empty filename", USER_ID, ""],
  ])("rejects %s", (_case, userId, filename) => {
    expect(resolveUserAvatarObjectPath(userId, filename)).toBeUndefined();
  });
});

describe("buildUserAvatarFilename", () => {
  it("is content-addressed, so the URL changes when the image does", () => {
    const first = filenameFor([1, 2, 3]);
    const second = filenameFor([4, 5, 6]);

    expect(first).not.toBe(second);
    expect(filenameFor([1, 2, 3])).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  it("uses the extension of the content type", () => {
    expect(buildUserAvatarFilename("image/jpeg", new Uint8Array([1]))).toMatch(/\.jpg$/);
    expect(buildUserAvatarFilename("image/webp", new Uint8Array([1]))).toMatch(/\.webp$/);
  });
});

/** The route's whole body handling, minus the session lookup it wraps. */
function pngForm(bytes: number[], extra?: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(extra ?? {})) form.set(key, value);
  form.set("image", new File([new Uint8Array(bytes)], "avatar.png", { type: "image/png" }));
  return form;
}

describe("parseAvatarUpload", () => {
  it("takes nothing from the body that could name the key's user", async () => {
    const upload = await parseAvatarUpload(
      pngForm([1, 2, 3], { userId: "usr_attacker", avatarUrl: "/resources/account/avatar/x/y" })
    );

    if (isAvatarUploadRejection(upload)) throw new Error("expected the upload to be accepted");

    // Only the caller's authenticated id reaches the key and the URL.
    const filename = buildUserAvatarFilename(upload.contentType, upload.data);
    const url = buildUserAvatarUrl(USER_ID, filename);

    expect(url).toBe(`/resources/account/avatar/${USER_ID}/${filename}`);
    expect(url).not.toContain("usr_attacker");
    expect(resolveUserAvatarObjectPath(USER_ID, filename)).toBe(`avatars/${USER_ID}/${filename}`);
    expect(Object.keys(upload)).toEqual(["contentType", "data"]);
  });

  it("rejects a missing image with 400", async () => {
    expect(await parseAvatarUpload(new FormData())).toEqual({
      error: "Missing image",
      status: 400,
    });
  });

  it("rejects a disallowed content type with 415", async () => {
    const form = new FormData();
    form.set("image", new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));

    expect(await parseAvatarUpload(form)).toMatchObject({ status: 415 });
  });

  it("rejects an image over the cap with 413", async () => {
    const form = new FormData();
    form.set(
      "image",
      new File([new Uint8Array(MAX_AVATAR_SIZE_IN_BYTES + 1)], "a.png", { type: "image/png" })
    );

    expect(await parseAvatarUpload(form)).toMatchObject({ status: 413 });
  });

  it("accepts an image exactly at the cap", async () => {
    const form = new FormData();
    form.set(
      "image",
      new File([new Uint8Array(MAX_AVATAR_SIZE_IN_BYTES)], "a.png", { type: "image/png" })
    );

    expect(isAvatarUploadRejection(await parseAvatarUpload(form))).toBe(false);
  });
});
