import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { type RegistryConfig } from "~/v3/registryConfig.server";
import { readDeploymentCheckImage } from "~/v3/services/deploymentCheckImage.server";

const HOST = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const PROJECT = "proj_abc123";
const REPO = `deployments-test/${PROJECT}`;
const OCI = "application/vnd.oci.image.manifest.v1+json";
const config: RegistryConfig = { host: HOST, namespace: "deployments-test" };
const readRole = {
  roleArn: "arn:aws:iam::123456789012:role/deployment-checks-ecr-read-test",
  externalId: "deployment-checks-test",
};

// Made-up keys: the STS call signs with BASE, the ECR calls must sign with the read role's.
const BASE = { accessKeyId: "AKIABASEEXAMPLE", secretAccessKey: "base-secret" };
const READ_ROLE_KEY = "ASIAREADROLEEXAMPLE";
const READ_ROLE_TOKEN = "read-role-session-token";

const digestOf = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const blob = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function manifestWith(layers: string[], configDigest = blob(9999)) {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: 10,
    },
    layers: layers.map((digest) => ({
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest,
      size: 10,
    })),
  });
}

type Entry = { imageManifest?: string; imageManifestMediaType?: string };
type Call = {
  operation: string;
  input: Record<string, unknown>;
  /** The access key the request was signed with. */
  signedBy: string;
  sessionToken?: string;
};

const ASSUME_ROLE_RESPONSE = `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>${READ_ROLE_KEY}</AccessKeyId>
      <SecretAccessKey>read-role-secret</SecretAccessKey>
      <SessionToken>${READ_ROLE_TOKEN}</SessionToken>
      <Expiration>2099-01-01T00:00:00Z</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <AssumedRoleId>AROAEXAMPLE:dc</AssumedRoleId>
      <Arn>arn:aws:sts::123456789012:assumed-role/deployment-checks-ecr-read-test/dc</Arn>
    </AssumedRoleUser>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata>
</AssumeRoleResponse>`;

const ACCESS_DENIED = `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not authorized</Message></Error>
  <RequestId>req-1</RequestId>
</ErrorResponse>`;

/**
 * A local endpoint for the real STS and ECR clients: it answers STS in its query/XML protocol and
 * ECR in its JSON 1.1 protocol, with the answers the test asks for, and records each request and
 * who signed it. Requests it holds (`hang`) are recorded in `cut` when the client gives up on them.
 */
async function startAws({
  entries = [],
  url = (digest: string) => ({
    layerDigest: digest,
    downloadUrl: `https://layers.s3.us-east-1.amazonaws.com/${digest}?X-Amz-Signature=s`,
  }),
  ecrError,
  stsDenied = false,
  hang,
}: {
  entries?: Entry[];
  url?: (digest: string) => { layerDigest?: string; downloadUrl?: string };
  ecrError?: string;
  stsDenied?: boolean;
  hang?: "AssumeRole" | "BatchGetImage";
} = {}) {
  const calls: Call[] = [];
  const cut: string[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const signedBy =
      /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    const sessionToken = req.headers["x-amz-security-token"] as string | undefined;
    const target = String(req.headers["x-amz-target"] ?? "");
    const operation = target ? (target.split(".").pop() ?? "") : "AssumeRole";
    const input: Record<string, unknown> = target
      ? (JSON.parse(body || "{}") as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(body));
    calls.push({ operation, input, signedBy, ...(sessionToken ? { sessionToken } : {}) });

    if (operation === hang) {
      res.on("close", () => cut.push(operation));
      return;
    }
    if (operation === "AssumeRole") {
      res.writeHead(stsDenied ? 403 : 200, { "content-type": "text/xml" });
      res.end(stsDenied ? ACCESS_DENIED : ASSUME_ROLE_RESPONSE);
      return;
    }
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify(value));
    };
    if (operation === "BatchGetImage") {
      if (ecrError) return json(400, { __type: ecrError, message: "made up" });
      return json(200, { images: entries, failures: [] });
    }
    if (operation === "GetDownloadUrlForLayer") {
      return json(200, url(String(input.layerDigest ?? "")));
    }
    json(400, { __type: "UnknownOperationException", message: operation });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const { port } = server.address() as AddressInfo;
  return {
    aws: { endpoint: `http://127.0.0.1:${port}`, credentials: BASE },
    calls,
    ecrCalls: () => calls.filter((call) => call.operation !== "AssumeRole"),
    cut,
  };
}

type Aws = Awaited<ReturnType<typeof startAws>>["aws"];

function read(
  manifest: string,
  aws: Aws,
  {
    digest = digestOf(manifest),
    projectRef = PROJECT,
    registryConfig = config,
    imageReference = `${HOST}/${REPO}:20260101.1.prod@${digest}`,
    withRole = true,
    timeoutMs,
  }: {
    digest?: string;
    projectRef?: string;
    registryConfig?: RegistryConfig;
    imageReference?: string;
    withRole?: boolean;
    timeoutMs?: number;
  } = {}
) {
  return readDeploymentCheckImage(
    {
      imageReference,
      imageDigest: digest,
      projectRef,
      registryConfig,
      ...(withRole ? { readRole } : {}),
    },
    { aws, ...(timeoutMs ? { timeoutMs } : {}) }
  );
}

/** Polls until `done()` holds, for at most 2 s. */
async function eventually(done: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!done() && performance.now() < deadline) await sleep(10);
  return done();
}

describe("readDeploymentCheckImage", () => {
  it("returns the manifest as ECR gave it and one URL per blob it names", async () => {
    // Catches: a URL missing for the config or a layer (the check can't read the image), a repeated
    // layer asked for twice, the manifest re-encoded (its digest would no longer match), or the
    // lookup going to another repository or registry.
    const manifest = manifestWith([blob(1), blob(2), blob(1)]);
    const { aws, ecrCalls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
    });

    const image = await read(manifest, aws);

    expect(image?.manifest).toBe(manifest);
    expect(image?.mediaType).toBe(OCI);
    expect(Object.keys(image?.blobUrls ?? {}).sort()).toEqual(
      [blob(1), blob(2), blob(9999)].sort()
    );
    const [batch, ...urls] = ecrCalls();
    expect(batch.operation).toBe("BatchGetImage");
    expect(batch.input).toEqual({
      registryId: "123456789012",
      repositoryName: REPO,
      imageIds: [{ imageDigest: digestOf(manifest) }],
      acceptedMediaTypes: [OCI, "application/vnd.docker.distribution.manifest.v2+json"],
    });
    expect(urls.map((call) => call.operation)).toEqual(Array(3).fill("GetDownloadUrlForLayer"));
    expect(urls.map((call) => call.input.repositoryName)).toEqual(Array(3).fill(REPO));
    // Each URL is the one ECR gave for that blob, not another blob's.
    for (const [digest, url] of Object.entries(image?.blobUrls ?? {})) {
      expect(url).toBe(`https://layers.s3.us-east-1.amazonaws.com/${digest}?X-Amz-Signature=s`);
    }
  });

  it("assumes the read role for this project, and reads ECR only as that role", async () => {
    // Catches: a swapped role ARN or external ID, a missing or renamed ProjectRef tag (the role's
    // trust refuses it and the policy matches no repository), or ECR read with the task's own or
    // the push credentials instead of the read role's session.
    const manifest = manifestWith([blob(1)]);
    const { aws, calls, ecrCalls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
    });

    expect(await read(manifest, aws)).not.toBeNull();

    const [assume] = calls;
    expect(assume.operation).toBe("AssumeRole");
    expect(assume.signedBy).toBe(BASE.accessKeyId);
    expect(assume.input).toMatchObject({
      Action: "AssumeRole",
      RoleArn: readRole.roleArn,
      ExternalId: readRole.externalId,
      DurationSeconds: "900",
      "Tags.member.1.Key": "ProjectRef",
      "Tags.member.1.Value": PROJECT,
    });
    expect(String(assume.input.RoleSessionName)).toMatch(new RegExp(`^dc-${PROJECT}-[0-9]+$`));
    expect(ecrCalls().length).toBeGreaterThan(0);
    for (const call of ecrCalls()) {
      expect(call.signedBy).toBe(READ_ROLE_KEY);
      expect(call.sessionToken).toBe(READ_ROLE_TOKEN);
    }
  });

  it("reads a digest with several tags, but not different images under one digest", async () => {
    // Catches: ECR's one-entry-per-tag answer read as a failure, or an inconsistent answer trusted.
    const manifest = manifestWith([blob(1)]);
    const same = await startAws({
      entries: [
        { imageManifest: manifest, imageManifestMediaType: OCI },
        { imageManifest: manifest, imageManifestMediaType: OCI },
      ],
    });
    expect(await read(manifest, same.aws)).not.toBeNull();
    const different = await startAws({
      entries: [
        { imageManifest: manifest, imageManifestMediaType: OCI },
        { imageManifest: manifestWith([blob(2)]), imageManifestMediaType: OCI },
      ],
    });
    expect(await read(manifest, different.aws)).toBeNull();
  });

  it("returns null for an image over the caps or not a single image, without asking for URLs", async () => {
    // Catches: URLs minted (and sent) for an image the check can't take anyway.
    const manifest = manifestWith([blob(1)]);
    const cases: Array<{ entries: Entry[]; digest?: string }> = [
      { entries: [] },
      {
        entries: [
          {
            imageManifest: manifest,
            imageManifestMediaType: "application/vnd.oci.image.index.v1+json",
          },
        ],
      },
      { entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }], digest: blob(42) },
      {
        entries: [
          {
            imageManifest: manifestWith(Array.from({ length: 129 }, (_, i) => blob(i + 1))),
            imageManifestMediaType: OCI,
          },
        ],
      },
      { entries: [{ imageManifest: manifestWith([]), imageManifestMediaType: OCI }] },
      { entries: [{ imageManifest: manifestWith(["latest"]), imageManifestMediaType: OCI }] },
      { entries: [{ imageManifest: "not json", imageManifestMediaType: OCI }] },
    ];
    for (const { entries, digest } of cases) {
      const m = entries[0]?.imageManifest ?? manifest;
      const { aws, ecrCalls } = await startAws({ entries });
      expect(await read(m, aws, { digest: digest ?? digestOf(m) })).toBeNull();
      expect(ecrCalls().some((call) => call.operation === "GetDownloadUrlForLayer")).toBe(false);
    }
  });

  it("returns null when ECR fails or hands back an unusable URL", async () => {
    // Catches: an ECR error thrown into the check job, or a URL for another blob, a plain http URL
    // or a missing one passed on to the check.
    const manifest = manifestWith([blob(1)]);
    const entries = [{ imageManifest: manifest, imageManifestMediaType: OCI }];
    const failing = await startAws({ entries, ecrError: "RepositoryNotFoundException" });
    expect(await read(manifest, failing.aws)).toBeNull();
    for (const url of [
      (d: string) => ({
        layerDigest: blob(77),
        downloadUrl: `https://x.s3.us-east-1.amazonaws.com/${d}`,
      }),
      (d: string) => ({ layerDigest: d, downloadUrl: `http://x.s3.us-east-1.amazonaws.com/${d}` }),
      (d: string) => ({ layerDigest: d }),
      (d: string) => ({ layerDigest: d, downloadUrl: `https://x/${"y".repeat(8 * 1024)}` }),
    ]) {
      const { aws } = await startAws({ entries, url });
      expect(await read(manifest, aws)).toBeNull();
    }
  });

  it("gives up after its time limit, cutting off the request still in flight", async () => {
    // Catches: a hung ECR or STS call holding the check job until the queue redelivers it, or a
    // timed-out read that keeps its requests open.
    const manifest = manifestWith([blob(1)]);
    const entries = [{ imageManifest: manifest, imageManifestMediaType: OCI }];

    const ecrHangs = await startAws({ entries, hang: "BatchGetImage" });
    expect(await read(manifest, ecrHangs.aws, { timeoutMs: 200 })).toBeNull();
    expect(
      await eventually(() => ecrHangs.cut.includes("BatchGetImage")),
      "the hung ECR request was never cut off"
    ).toBe(true);

    const stsHangs = await startAws({ entries, hang: "AssumeRole" });
    expect(await read(manifest, stsHangs.aws, { timeoutMs: 200 })).toBeNull();
    expect(
      await eventually(() => stsHangs.cut.includes("AssumeRole")),
      "the hung STS request was never cut off"
    ).toBe(true);
    expect(stsHangs.ecrCalls()).toEqual([]);
  });

  it("leaves images outside the configured ECR registry alone", async () => {
    // Catches: a lookup for an image the platform doesn't own, or on a non-ECR registry.
    const manifest = manifestWith([blob(1)]);
    const { aws, calls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
    });
    const digest = digestOf(manifest);
    expect(
      await read(manifest, aws, { imageReference: `other.example.com/${REPO}:t@${digest}` })
    ).toBeNull();
    expect(
      await read(manifest, aws, {
        imageReference: `registry.example.com/${REPO}:t@${digest}`,
        registryConfig: { host: "registry.example.com", namespace: "x" },
      })
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads only the project's own repository", async () => {
    // Catches: a deployment whose image reference names another project's repository being read
    // with this project's read role, or a ref that only shares a prefix passing the check.
    const manifest = manifestWith([blob(1)]);
    const { aws, calls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
    });
    for (const projectRef of ["proj_other", "proj_abc", "proj_abc1234", ""]) {
      expect(await read(manifest, aws, { projectRef })).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("reads nothing without a read role", async () => {
    // Catches: falling back to other registry credentials (the push role) when the read role
    // isn't configured.
    const manifest = manifestWith([blob(1)]);
    const { aws, calls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
    });
    expect(
      await read(manifest, aws, {
        withRole: false,
        registryConfig: {
          ...config,
          ecrAssumeRoleArn: "arn:aws:iam::123456789012:role/push",
          ecrAssumeRoleExternalId: "x",
        },
      })
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads nothing when the read role can't be assumed", async () => {
    // Catches: going on to ECR with some other identity after STS refuses.
    const manifest = manifestWith([blob(1)]);
    const { aws, calls, ecrCalls } = await startAws({
      entries: [{ imageManifest: manifest, imageManifestMediaType: OCI }],
      stsDenied: true,
    });
    expect(await read(manifest, aws)).toBeNull();
    expect(calls.map((call) => call.operation)).toEqual(["AssumeRole"]);
    expect(ecrCalls()).toEqual([]);
  });
});
