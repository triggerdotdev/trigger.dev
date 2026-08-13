# Deploy base images

Base images for deployed task containers, published to Docker Hub as
`triggerdotdev/node:<major>-bookworm` and `triggerdotdev/bun:<line>-node<major>-bookworm`,
each with a `-build` variant that adds the native-module toolchain
(python3, make, g++).

Each image is its upstream slim base (pinned by digest in `images.json`) with
all preinstalled Debian packages upgraded to the pinned snapshot state, plus
the system packages deployed tasks rely on: busybox, ca-certificates,
dumb-init, git, openssl. apt stays configured for the live Debian archive, so
images derived from these behave like their upstream bases.

## Tags and pinning

Tags are mutable and rebuilt in place on demand; each rebuild picks up Debian
security updates published up to its snapshot date. Every publish also pushes
an immutable per-publish tag (snapshot timestamp plus commit, e.g. `22-bookworm-20260812-000000-45444a7`) so previously
published digests stay tag-referenced; never delete these, since shipped CLI
releases pin their digests. The
runtime itself (the node or bun binaries from the upstream base) only moves
when the base digests in `images.json` are bumped. When bumping a base
digest, keep the snapshot at least as new as the upstream image's own archive
state, or the upgrade step silently becomes a no-op. Consumers pin digests: the CLI's generated
Containerfile references these images as `triggerdotdev/node:22-bookworm@sha256:...`,
and digests only move when a CLI release updates its pins.

## Reproducibility and provenance

Packages install from a [Debian snapshot archive](https://snapshot.debian.org)
timestamp recorded in the `dev.trigger.debian-snapshot` image label, and the
workflow exports layers with timestamps normalized to the snapshot date
(`SOURCE_DATE_EPOCH` plus `rewrite-timestamp`), so a published image's layers
are a pure function of
(upstream base digest, snapshot timestamp, package list). To verify, rebuild
with the recorded inputs and compare layer digests (the manifest and config
digests differ because they carry build metadata labels like the source
revision):

```bash
# needs a docker-container builder (docker buildx create --use)
SNAPSHOT=$(docker buildx imagetools inspect triggerdotdev/node:22-bookworm \
  --format '{{index (index .Image "linux/amd64").Config.Labels "dev.trigger.debian-snapshot"}}')
# GNU date; the epoch must match the one the workflow derived from the snapshot
EPOCH=$(date -u -d "${SNAPSHOT:0:4}-${SNAPSHOT:4:2}-${SNAPSHOT:6:2} ${SNAPSHOT:9:2}:${SNAPSHOT:11:2}:${SNAPSHOT:13:2}Z" +%s)
docker buildx build base-images --target runtime \
  --build-arg BASE_IMAGE="<base from images.json>" \
  --build-arg PACKAGES="<packages from images.json>" \
  --build-arg DEBIAN_SNAPSHOT="$SNAPSHOT" \
  --build-arg SOURCE_DATE_EPOCH="$EPOCH" \
  --platform linux/amd64,linux/arm64 \
  --provenance false \
  --output type=oci,dest=rebuilt.tar,rewrite-timestamp=true
# then compare .layers[].digest of the rebuilt per-platform manifests against
# the published ones (imagetools inspect --raw returns the index; fetch each
# platform manifest it references to see its layers). For the -build variant,
# use --target build and additionally pass --build-arg BUILD_PACKAGES. Layer
# digests are stable for a given BuildKit version and compression settings.
```

Every published digest carries a GitHub build provenance attestation (a
publish whose attestation fails goes red and is re-run):

```bash
gh attestation verify oci://index.docker.io/triggerdotdev/node:22-bookworm \
  --repo triggerdotdev/trigger.dev \
  --signer-workflow triggerdotdev/trigger.dev/.github/workflows/base-images.yml
```

## Publishing

`.github/workflows/base-images.yml` publishes on manual dispatch and on
changes to this directory. Pull requests build the images
without pushing. After a publish, the digests in the job summary are used to
update the `BASE_IMAGE` pins in `packages/cli-v3/src/deploy/buildImage.ts`.
