# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom

# Base images for deployed task containers; see README.md. Packages install
# from a pinned Debian snapshot, then apt is restored to the live archive.

ARG BASE_IMAGE
# node entries leave these at their defaults; bun entries set RUNTIME_KIND=bun
# and BUN_SOURCE_IMAGE so the runtime-bun stage below is selected. For node builds
# neither the bun-source stage nor runtime-bun is in the target's graph, so the
# scratch default is never pulled or copied.
ARG RUNTIME_KIND=node
ARG BUN_SOURCE_IMAGE=scratch

# We build our own bun images instead of depending on a third-party one: the
# bun binary is copied from the official oven/bun image (pinned by digest in
# images.json) onto either a node slim base (the node+bun "legacy" image, which
# keeps a node binary for tasks that shell out to it) or a plain debian slim base
# (the node-less images, which contain no node at all). Layout matches what
# deployed bun tasks expect: bun on PATH at /usr/local/bin/bun, BUN_INSTALL_BIN
# pointing there (resolved by execPathForRuntime), and a bun user/group at uid/gid
# 1001 (the node base already owns 1000; supervisor pins bun tasks to 1001).
FROM ${BUN_SOURCE_IMAGE} AS bun-source

FROM ${BASE_IMAGE} AS runtime-node

FROM ${BASE_IMAGE} AS runtime-bun
ARG BUN_INSTALL_BIN=/usr/local/bin
ENV BUN_INSTALL_BIN=${BUN_INSTALL_BIN}
# Ephemeral task containers gain nothing from the on-disk transpiler cache.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
RUN groupadd bun --gid 1001 && \
  useradd bun --uid 1001 --gid bun --shell /bin/sh --create-home && \
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
  bun --version

FROM runtime-${RUNTIME_KIND} AS runtime

ARG DEBIAN_SNAPSHOT
ARG DEBIAN_SUITE=bookworm
ARG PACKAGES

# ARG, not ENV: needed during build only, must not leak into task containers
ARG DEBIAN_FRONTEND=noninteractive

# http, not https: the slim bases have no ca-certificates yet, and apt
# integrity comes from GPG-signed Release files rather than TLS.
# check-valid-until=no: pinned Release files outlive their Valid-Until window.
RUN . /etc/os-release && [ "$VERSION_CODENAME" = "${DEBIAN_SUITE}" ] || { echo "Base image is Debian $VERSION_CODENAME but this build pins ${DEBIAN_SUITE} apt sources"; exit 1; } && \
  [ -n "${DEBIAN_SNAPSHOT}" ] && [ -n "${PACKAGES}" ] || { echo "DEBIAN_SNAPSHOT and PACKAGES build args are required (see images.json)"; exit 1; } && \
  mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources && \
  { [ ! -f /etc/apt/sources.list ] || mv /etc/apt/sources.list /tmp/upstream-sources.list; } && \
  printf '%s\n' \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE} main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-security main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-updates main" \
    > /etc/apt/sources.list.d/snapshot.list && \
  printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/99-snapshot-retries && \
  apt-get update && \
  apt-get upgrade -y --with-new-pkgs && \
  apt-get install -y --no-install-recommends ${PACKAGES} && \
  apt-get clean && \
  rm /etc/apt/sources.list.d/snapshot.list /etc/apt/apt.conf.d/99-snapshot-retries && \
  mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources && \
  { [ ! -f /tmp/upstream-sources.list ] || mv /tmp/upstream-sources.list /etc/apt/sources.list; } && \
  rm -rf /var/lib/apt/lists/* /var/log/dpkg.log /var/log/apt /var/log/alternatives.log /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old

FROM runtime AS build

ARG DEBIAN_SNAPSHOT
ARG DEBIAN_SUITE=bookworm
ARG BUILD_PACKAGES
ARG DEBIAN_FRONTEND=noninteractive

RUN [ -n "${DEBIAN_SNAPSHOT}" ] && [ -n "${BUILD_PACKAGES}" ] || { echo "DEBIAN_SNAPSHOT and BUILD_PACKAGES build args are required (see images.json)"; exit 1; } && \
  mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources && \
  { [ ! -f /etc/apt/sources.list ] || mv /etc/apt/sources.list /tmp/upstream-sources.list; } && \
  printf '%s\n' \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE} main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-security main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-updates main" \
    > /etc/apt/sources.list.d/snapshot.list && \
  printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/99-snapshot-retries && \
  apt-get update && \
  apt-get install -y --no-install-recommends ${BUILD_PACKAGES} && \
  apt-get clean && \
  rm /etc/apt/sources.list.d/snapshot.list /etc/apt/apt.conf.d/99-snapshot-retries && \
  mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources && \
  { [ ! -f /tmp/upstream-sources.list ] || mv /tmp/upstream-sources.list /etc/apt/sources.list; } && \
  rm -rf /var/lib/apt/lists/* /var/log/dpkg.log /var/log/apt /var/log/alternatives.log /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old
