# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom

# Base images for deployed task containers; see README.md. Packages install
# from a pinned Debian snapshot, then apt is restored to the live archive.

ARG BASE_IMAGE

FROM ${BASE_IMAGE} AS runtime

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
