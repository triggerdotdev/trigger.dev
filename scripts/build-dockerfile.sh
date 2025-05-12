#!/bin/bash

set -e

docker build -t local-triggerdotdev:latest -f docker/Dockerfile .
image=local-triggerdotdev:latest
src=/triggerdotdev
dst=$(mktemp -d)

mkdir -p $dst

echo -e "Extracting image into $dst..."

container=$(docker create "$image")
docker cp "$container:$src" "$dst"
docker rm "$container"
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code "$dst/triggerdotdev"

