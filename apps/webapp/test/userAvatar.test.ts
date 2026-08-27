import { afterEach, describe, expect, it } from "vitest";
import { env } from "~/env.server";
import {
  buildUserAvatarFilename,
  buildUserAvatarUrl,
  isAvatarUploadRejection,
  absoluteUserAvatarUrl,
  avatarObjectStoreImageOrigin,
  parseAvatarUpload,
  presignUserAvatarUrl,
  resolveStaleAvatarObjectPath,
  resolveUserAvatarObjectPath,
} from "~/services/userAvatar.server";
import { MAX_AVATAR_SIZE_IN_BYTES } from "~/utils/avatarLimits";

const USER_ID = "clzabc123";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function filenameFor(bytes: number[]) {
  return buildUserAvatarFilename("image/png", new Uint8Array(bytes));
}

function imageFile(type: string, bytes: number[], padTo = 0) {
  const data = new Uint8Array(Math.max(padTo, bytes.length));
  data.set(bytes);
  return new File([data], "avatar.bin", { type });
}

function formWith(file: File) {
  const form = new FormData();
  form.set("image", file);
  return form;
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

describe("parseAvatarUpload", () => {
  it("takes nothing from the body that could name the key's user", async () => {
    const form = formWith(imageFile("image/png", PNG_MAGIC));
    form.set("userId", "usr_attacker");
    form.set("avatarUrl", "/resources/account/avatar/x/y");

    const upload = await parseAvatarUpload(form);

    if (isAvatarUploadRejection(upload)) throw new Error("expected the upload to be accepted");

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
    const form = formWith(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));

    expect(await parseAvatarUpload(form)).toMatchObject({ status: 415 });
  });

  it("rejects an image over the cap with 413", async () => {
    const form = formWith(imageFile("image/png", PNG_MAGIC, MAX_AVATAR_SIZE_IN_BYTES + 1));

    expect(await parseAvatarUpload(form)).toMatchObject({ status: 413 });
  });

  it("accepts an image exactly at the cap", async () => {
    const form = formWith(imageFile("image/png", PNG_MAGIC, MAX_AVATAR_SIZE_IN_BYTES));

    expect(isAvatarUploadRejection(await parseAvatarUpload(form))).toBe(false);
  });

  it.each([
    ["png", "image/png", PNG_MAGIC],
    ["jpeg", "image/jpeg", JPEG_MAGIC],
    ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ])("accepts %s bytes matching their declared type", async (_case, type, magic) => {
    const form = formWith(imageFile(type, magic));

    expect(isAvatarUploadRejection(await parseAvatarUpload(form))).toBe(false);
  });

  it.each([
    ["png bytes declared as jpeg", "image/jpeg", PNG_MAGIC],
    ["jpeg bytes declared as png", "image/png", JPEG_MAGIC],
    ["garbage declared as png", "image/png", [1, 2, 3, 4, 5, 6, 7, 8]],
    ["an html payload declared as webp", "image/webp", [0x3c, 0x21, 0x64, 0x6f, 0x63, 0x74]],
    ["a truncated png header", "image/png", PNG_MAGIC.slice(0, 4)],
    ["an empty file", "image/png", []],
  ])("rejects %s with 415", async (_case, type, bytes) => {
    const form = formWith(imageFile(type, bytes));

    expect(await parseAvatarUpload(form)).toMatchObject({ status: 415 });
  });
});

describe("absoluteUserAvatarUrl", () => {
  it("absolutises an uploaded avatar so an API client can fetch it", () => {
    expect(absoluteUserAvatarUrl(`/resources/account/avatar/${USER_ID}/a.png`)).toBe(
      `${env.APP_ORIGIN}/resources/account/avatar/${USER_ID}/a.png`
    );
  });

  it.each([
    ["an OAuth avatar", "https://avatars.githubusercontent.com/u/1?v=4"],
    ["no avatar", null],
  ])("leaves %s untouched", (_case, avatarUrl) => {
    expect(absoluteUserAvatarUrl(avatarUrl)).toBe(avatarUrl);
  });
});

describe("resolveStaleAvatarObjectPath", () => {
  const previous = filenameFor([1, 2, 3]);
  const next = filenameFor([4, 5, 6]);

  it("derives the old object from the stored URL", () => {
    expect(
      resolveStaleAvatarObjectPath({
        previousAvatarUrl: buildUserAvatarUrl(USER_ID, previous),
        userId: USER_ID,
        filename: next,
      })
    ).toBe(`avatars/${USER_ID}/${previous}`);
  });

  it("keeps the object when the content hash is unchanged", () => {
    expect(
      resolveStaleAvatarObjectPath({
        previousAvatarUrl: buildUserAvatarUrl(USER_ID, previous),
        userId: USER_ID,
        filename: previous,
      })
    ).toBeUndefined();
  });

  it.each([
    ["no previous avatar", null],
    ["an OAuth avatar hosted elsewhere", "https://avatars.githubusercontent.com/u/1?v=4"],
    [
      "an absolute URL onto our own path",
      `https://evil.test/resources/account/avatar/${USER_ID}/${previous}`,
    ],
    ["another user's avatar", `/resources/account/avatar/usr_other/${previous}`],
    [
      "a filename that is not content-addressed",
      `/resources/account/avatar/${USER_ID}/../../secret.png`,
    ],
    ["a deeper path", `/resources/account/avatar/${USER_ID}/${previous}/extra`],
    ["an unrelated app path", "/resources/account/photo"],
  ])("leaves %s alone", (_case, previousAvatarUrl) => {
    expect(
      resolveStaleAvatarObjectPath({ previousAvatarUrl, userId: USER_ID, filename: next })
    ).toBeUndefined();
  });
});

const S3_ENV_KEYS = [
  "OBJECT_STORE_S3_BASE_URL",
  "OBJECT_STORE_S3_BUCKET",
  "OBJECT_STORE_S3_ACCESS_KEY_ID",
  "OBJECT_STORE_S3_SECRET_ACCESS_KEY",
  "OBJECT_STORE_S3_REGION",
] as const;

describe("the avatar object store", () => {
  const originalS3Env = Object.fromEntries(S3_ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalDefaultBaseUrl = env.OBJECT_STORE_BASE_URL;
  const originalDefaultBucket = env.OBJECT_STORE_BUCKET;

  function setS3Env(values: Partial<Record<(typeof S3_ENV_KEYS)[number], string>>) {
    for (const key of S3_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }

  afterEach(() => {
    for (const key of S3_ENV_KEYS) {
      const original = originalS3Env[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    env.OBJECT_STORE_BASE_URL = originalDefaultBaseUrl;
    env.OBJECT_STORE_BUCKET = originalDefaultBucket;
  });

  it("reads OBJECT_STORE_S3_*, never the default protocol", () => {
    setS3Env({});
    env.OBJECT_STORE_BASE_URL = "https://default-store.test";
    env.OBJECT_STORE_BUCKET = "packets";
    process.env.OBJECT_STORE_BASE_URL = "https://default-store.test";
    process.env.OBJECT_STORE_BUCKET = "packets";

    expect(() => presignUserAvatarUrl(`avatars/${USER_ID}/a.png`)).toThrow(/protocol: s3/);
  });

  it("requires its own bucket", () => {
    setS3Env({
      OBJECT_STORE_S3_BASE_URL: "https://s3-no-bucket.test",
      OBJECT_STORE_S3_ACCESS_KEY_ID: "key",
      OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(() => presignUserAvatarUrl(`avatars/${USER_ID}/a.png`)).toThrow(
      /OBJECT_STORE_S3_BUCKET/
    );
  });

  it("signs a short-lived URL under the S3 bucket", async () => {
    setS3Env({
      OBJECT_STORE_S3_BASE_URL: "https://s3-signing.test",
      OBJECT_STORE_S3_BUCKET: "avatars-bucket",
      OBJECT_STORE_S3_ACCESS_KEY_ID: "key",
      OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret",
      OBJECT_STORE_S3_REGION: "us-east-1",
    });

    const url = await presignUserAvatarUrl(`avatars/${USER_ID}/a.png`);

    expect(url).toContain(`/avatars-bucket/avatars/${USER_ID}/a.png`);
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("avatarObjectStoreImageOrigin", () => {
  const originalBaseUrl = env.OBJECT_STORE_S3_BASE_URL;

  afterEach(() => {
    env.OBJECT_STORE_S3_BASE_URL = originalBaseUrl;
  });

  it("is the store's origin when one is configured, http included", () => {
    env.OBJECT_STORE_S3_BASE_URL = "http://localhost:9005";

    expect(avatarObjectStoreImageOrigin()).toBe("http://localhost:9005");
  });

  it("keeps only the origin of a store URL that carries a path", () => {
    env.OBJECT_STORE_S3_BASE_URL = "https://s3.eu-west-1.amazonaws.com/avatars";

    expect(avatarObjectStoreImageOrigin()).toBe("https://s3.eu-west-1.amazonaws.com");
  });

  it("is undefined when no avatar store is configured", () => {
    env.OBJECT_STORE_S3_BASE_URL = undefined;

    expect(avatarObjectStoreImageOrigin()).toBeUndefined();
  });
});
