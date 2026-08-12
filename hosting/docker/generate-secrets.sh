#!/bin/sh
# Generate strong, unique secrets and datastore passwords into the self-hosting .env.
#
# Safe to re-run: only fills values that are missing or empty, and never overwrites
# one that is already set. Rotating a live secret would orphan encrypted data, log
# everyone out, or break an already-initialised datastore volume - so rotation is
# opt-in only, via --force (which WILL break existing data/sessions).
set -eu

FORCE=0
for arg in "$@"; do
    case "$arg" in
        -f | --force) FORCE=1 ;;
        -h | --help)
            echo "Usage: $0 [--force] [env-file]"
            echo "  --force   Regenerate every secret, overwriting existing values."
            echo "            WARNING: rotates live secrets - breaks encrypted data, sessions,"
            echo "            and already-initialised datastore volumes."
            exit 0
            ;;
        *) env_file="$arg" ;;
    esac
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="${env_file:-$script_dir/.env}"
env_example="$script_dir/.env.example"
htpasswd_file="$script_dir/registry/auth.htpasswd"

# openssl rand -hex 16 -> 32 hex chars: URL-safe (no @ : / etc. to break connection
# strings) and satisfies the webapp's exact-32-byte ENCRYPTION_KEY check.
gen() { openssl rand -hex 16; }

if [ ! -f "$env_file" ]; then
    cp "$env_example" "$env_file"
    echo "Created $(basename "$env_file") from $(basename "$env_example")"
fi

sed_inplace() {
    if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# Value of KEY= in the env file, trailing inline comment/whitespace stripped, so
# "KEY=" and "KEY= # todo" both read as unset.
current_value() {
    grep -E "^$1=" "$env_file" | head -n1 | cut -d= -f2- \
        | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//'
}

set_var() {
    key="$1"
    value="$2"
    if grep -qE "^$key=" "$env_file"; then
        sed_inplace -e "s|^$key=.*|$key=$value|" "$env_file"
    else
        printf '%s=%s\n' "$key" "$value" >>"$env_file"
    fi
}

# Fill KEY with a fresh secret unless it already has a value (respecting --force).
# Returns 0 if it wrote, 1 if it skipped.
fill() {
    key="$1"
    if [ "$FORCE" -eq 0 ] && [ -n "$(current_value "$key")" ]; then
        return 1
    fi
    set_var "$key" "$(gen)"
    echo "Generated $key"
    return 0
}

generated=0

# App + control-plane secrets, and the bundled-datastore passwords. All plain
# values consumed directly (or, for datastores, woven into the connection URLs by
# docker-compose interpolation - see .env.example).
for key in \
    SESSION_SECRET MAGIC_LINK_SECRET ENCRYPTION_KEY \
    PROVIDER_SECRET COORDINATOR_SECRET MANAGED_WORKER_SECRET \
    POSTGRES_PASSWORD CLICKHOUSE_PASSWORD OBJECT_STORE_SECRET_ACCESS_KEY; do
    if fill "$key"; then generated=$((generated + 1)); fi
done

# Registry is special: the bundled registry authenticates against a bcrypt htpasswd
# file, so when we set its password we must regenerate that file to match. bcrypt is
# the only hash the registry accepts, and openssl can't produce it - use httpd's
# htpasswd via docker (already required for this stack).
if [ "$FORCE" -eq 1 ] || [ -z "$(current_value DOCKER_REGISTRY_PASSWORD)" ]; then
    registry_user=$(current_value DOCKER_REGISTRY_USERNAME)
    registry_user=${registry_user:-registry-user}
    registry_pass=$(gen)
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERROR: docker is required to hash the registry password (bcrypt). Install docker and re-run." >&2
        exit 1
    fi
    docker run --rm httpd:2 htpasswd -Bbn "$registry_user" "$registry_pass" >"$htpasswd_file"
    set_var DOCKER_REGISTRY_PASSWORD "$registry_pass"
    echo "Generated DOCKER_REGISTRY_PASSWORD (and wrote $(basename "$htpasswd_file"))"
    generated=$((generated + 1))
fi

if [ "$generated" -eq 0 ]; then
    echo "All secrets already set in $(basename "$env_file"); nothing to do. Use --force to rotate."
else
    echo "Wrote $generated secret(s) to $(basename "$env_file")."
fi
