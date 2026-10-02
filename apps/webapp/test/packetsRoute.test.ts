import {
  createStandalonePostgresContainer,
  MinIOContainer,
  type StartedMinIOContainer,
} from "@internal/testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestUser } from "./helpers/seedTestSession";

import type * as Route from "~/routes/resources.packets.$environmentId.$";
import type * as Database from "~/db.server";
import type * as SessionStorage from "~/services/sessionStorage.server";
import type * as ObjectStore from "~/v3/objectStore.server";

vi.setConfig({ testTimeout: 60_000 });

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let minio: StartedMinIOContainer;
let loader: typeof Route.loader;
let database: typeof Database;
let sessionStorage: typeof SessionStorage;
let objectStore: typeof ObjectStore;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  minio = await new MinIOContainer().start();
  const store = minio.getConnectionConfig();

  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("RBAC_FORCE_FALLBACK", "1");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-for-e2e!!!!!");
  for (const prefix of ["OBJECT_STORE_", "OBJECT_STORE_S3_"]) {
    vi.stubEnv(`${prefix}BASE_URL`, store.baseUrl);
    vi.stubEnv(`${prefix}ACCESS_KEY_ID`, store.accessKeyId);
    vi.stubEnv(`${prefix}SECRET_ACCESS_KEY`, store.secretAccessKey);
    vi.stubEnv(`${prefix}REGION`, store.region);
    vi.stubEnv(`${prefix}SERVICE`, "s3");
  }

  database = await import("~/db.server");
  ({ loader } = await import("~/routes/resources.packets.$environmentId.$"));
  sessionStorage = await import("~/services/sessionStorage.server");
  objectStore = await import("~/v3/objectStore.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  await minio?.stop({ timeout: 0 });
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await minio.resetBucket();
});

async function seedMember() {
  const { organization, project, environment } = await seedTestEnvironment(database.prisma);
  const user = await seedTestUser(database.prisma);
  await database.prisma.orgMember.create({
    data: { userId: user.id, organizationId: organization.id, role: "MEMBER" },
  });
  const session = await sessionStorage.getSession();
  session.set("user", { userId: user.id });
  const cookie = (await sessionStorage.commitSession(session)).split(";")[0];
  return { project, environment, cookie };
}

async function putPacket(
  projectRef: string,
  envSlug: string,
  filename: string,
  body: string,
  forceNoPrefix = false
) {
  const signed = await objectStore.generatePresignedRequest(projectRef, envSlug, filename, "PUT", {
    forceNoPrefix,
  });
  if (!signed.success) throw new Error(signed.error);
  const response = await fetch(signed.request.url, {
    method: "PUT",
    headers: signed.request.headers,
    body,
  });
  expect(response.status).toBe(200);
}

function download(environmentId: string, packet: string, cookie: string) {
  return loader({
    request: new Request(`https://app.example.com/resources/packets/${environmentId}/${packet}`, {
      headers: { Cookie: cookie },
    }),
    params: { environmentId, "*": packet },
    context: {},
  });
}

describe("resources.packets download", () => {
  it("returns an offloaded s3:// packet as an attachment", async () => {
    const { project, environment, cookie } = await seedMember();
    await putPacket(project.externalRef, environment.slug, "s3://run_abc/output.json", '{"ok":1}');

    const response = await download(environment.id, "s3://run_abc/output.json", cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="output.json"');
    expect(await response.text()).toBe('{"ok":1}');
  });

  it("returns a legacy unprefixed packet", async () => {
    const { project, environment, cookie } = await seedMember();
    await putPacket(
      project.externalRef,
      environment.slug,
      "batch_123/item_0/payload.json",
      '{"legacy":true}',
      true
    );

    const response = await download(environment.id, "batch_123/item_0/payload.json", cookie);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"legacy":true}');
  });

  it("reports a missing packet as 404 instead of downloading the store's error", async () => {
    const { environment, cookie } = await seedMember();

    const response = await download(environment.id, "s3://run_missing/output.json", cookie);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(body).not.toContain("<?xml");
    expect(body).not.toContain("NoSuchKey");
  });
});
