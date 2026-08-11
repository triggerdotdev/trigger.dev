# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom

# Base images for deployed task containers. Packages install from a pinned
# Debian snapshot so any published digest can be rebuilt and verified from
# (upstream base digest, snapshot timestamp, package list); apt is restored to
# the upstream live-archive configuration afterwards so derived images behave
# like their upstream bases.

ARG BASE_IMAGE

FROM ${BASE_IMAGE} AS runtime

ARG DEBIAN_SNAPSHOT
ARG DEBIAN_SUITE=bookworm
ARG PACKAGES

ENV DEBIAN_FRONTEND=noninteractive

# http, not https: the slim bases have no ca-certificates yet, and apt
# integrity comes from GPG-signed Release files rather than TLS.
# check-valid-until=no: pinned Release files outlive their Valid-Until window.
RUN . /etc/os-release && [ "$VERSION_CODENAME" = "${DEBIAN_SUITE}" ] || { echo "Base image is Debian $VERSION_CODENAME but this build pins ${DEBIAN_SUITE} apt sources"; exit 1; } && \
  [ -n "${DEBIAN_SNAPSHOT}" ] && [ -n "${PACKAGES}" ] || { echo "DEBIAN_SNAPSHOT and PACKAGES build args are required (see images.json)"; exit 1; } && \
  mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources && \
  printf '%s\n' \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE} main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-security main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-updates main" \
    > /etc/apt/sources.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends ${PACKAGES} && \
  apt-get clean && \
  rm /etc/apt/sources.list && \
  mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources && \
  rm -rf /var/lib/apt/lists/* /var/log/dpkg.log /var/log/apt /var/log/alternatives.log /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old

FROM runtime AS build

ARG DEBIAN_SNAPSHOT
ARG DEBIAN_SUITE=bookworm
ARG BUILD_PACKAGES

RUN [ -n "${DEBIAN_SNAPSHOT}" ] && [ -n "${BUILD_PACKAGES}" ] || { echo "DEBIAN_SNAPSHOT and BUILD_PACKAGES build args are required (see images.json)"; exit 1; } && \
  mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources && \
  printf '%s\n' \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE} main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-security main" \
    "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} ${DEBIAN_SUITE}-updates main" \
    > /etc/apt/sources.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends ${BUILD_PACKAGES} && \
  apt-get clean && \
  rm /etc/apt/sources.list && \
  mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources && \
  rm -rf /var/lib/apt/lists/* /var/log/dpkg.log /var/log/apt /var/log/alternatives.log /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old
