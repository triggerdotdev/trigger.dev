# Deploy base images

Base images for deployed task containers, published to Docker Hub as
`triggerdotdev/node:<major>-bookworm` and `triggerdotdev/bun:<line>-bookworm`,
each with a `-build` variant that adds the native-module toolchain
(python3, make, g++).

Each image is its upstream slim base (pinned by digest in `images.json`) plus
the system packages deployed tasks rely on: busybox, ca-certificates,
dumb-init, git, openssl. Nothing else changes; apt stays configured for the
live Debian archive, so images derived from these behave exactly like their
upstream bases.

## Tags and pinning

Tags are mutable and rebuilt in place (weekly, and on demand) so packages pick
up Debian security updates. Consumers pin digests: the CLI's generated
Containerfile references these images as `triggerdotdev/node:22-bookworm@sha256:...`,
and digests only move when a CLI release updates its pins.

## Reproducibility and provenance

Packages install from a [Debian snapshot archive](https://snapshot.debian.org)
timestamp recorded in the `dev.trigger.debian-snapshot` image label, and the
workflow exports layers with normalized timestamps (`SOURCE_DATE_EPOCH=0` plus
`rewrite-timestamp`), so a published image's layers are a pure function of
(upstream base digest, snapshot timestamp, package list). To verify, rebuild
with the recorded inputs and compare layer digests (the manifest and config
digests differ because they carry build metadata labels like the source
revision):

```bash
SNAPSHOT=$(docker inspect triggerdotdev/node:22-bookworm --format '{{index .Config.Labels "dev.trigger.debian-snapshot"}}')
docker buildx build base-images --target runtime \
  --build-arg BASE_IMAGE="<base from images.json>" \
  --build-arg PACKAGES="<packages from images.json>" \
  --build-arg DEBIAN_SNAPSHOT="$SNAPSHOT" \
  --build-arg SOURCE_DATE_EPOCH=0 \
  --platform linux/amd64,linux/arm64 \
  --provenance false \
  --output type=oci,dest=rebuilt.tar,rewrite-timestamp=true
# then compare .layers[].digest of the rebuilt manifests against
# `docker buildx imagetools inspect triggerdotdev/node:22-bookworm --raw`
```

Every published digest also carries a GitHub build provenance attestation:

```bash
gh attestation verify oci://index.docker.io/triggerdotdev/node:22-bookworm --owner triggerdotdev
```

## Publishing

`.github/workflows/base-images.yml` publishes on a weekly schedule, on manual
dispatch, and on changes to this directory. Pull requests build the images
without pushing. After a publish, the digests in the job summary are used to
update the `BASE_IMAGE` pins in `packages/cli-v3/src/deploy/buildImage.ts`.
