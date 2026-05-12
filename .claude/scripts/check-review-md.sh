#!/usr/bin/env bash
# Check that paths and packages cited in .claude/REVIEW.md still exist.
# Exits 1 if any cited path/package is missing, 0 otherwise.
# Designed to be runnable locally and from CI.

set -uo pipefail

REVIEW="${1:-.claude/REVIEW.md}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

if [[ ! -f "$REVIEW" ]]; then
  echo "No $REVIEW found — skipping check"
  exit 0
fi

declare -a ERRORS=()
declare -a WARNINGS=()

# Extract every backtick-quoted token. We deliberately ignore fenced code
# blocks (```...```) — those are illustrative examples, not citations to
# verify.
mapfile -t REFS < <(
  awk '
    /^```/ { inblock = !inblock; next }
    !inblock {
      while (match($0, /`[^`]+`/)) {
        print substr($0, RSTART+1, RLENGTH-2)
        $0 = substr($0, RSTART+RLENGTH)
      }
    }
  ' "$REVIEW" | sort -u
)

is_path_like() {
  local s="$1"
  # Path-like: contains a slash, OR ends in a recognized file extension
  case "$s" in
    */*) return 0 ;;
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.mdx|*.sql|*.prisma|*.lua|*.yml|*.yaml|*.sh|*.toml) return 0 ;;
    *) return 1 ;;
  esac
}

is_package_like() {
  local s="$1"
  [[ "$s" == @*/?* ]]
}

# Heuristic skips: things in backticks that aren't paths or packages.
# These are usually code snippets, function names, table names, etc.
# We do NOT check them — too many false positives.
should_skip() {
  local s="$1"
  # Slash-command form (starts with / and has no further /): e.g. /code-review
  if [[ "$s" == /* && "$s" != /*/* ]]; then
    return 0
  fi
  case "$s" in
    *" "*) return 0 ;;          # contains space — prose
    *"("*|*")"*) return 0 ;;    # function call syntax
    *"{"*|*"}"*) return 0 ;;
    *"="*|*";"*) return 0 ;;
    *"<"*|*">"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve glob-bearing paths to their longest static prefix dir.
# `packages/*` → `packages`
# `.changeset/*.md` → `.changeset`
# Pure paths return unchanged.
resolve_glob_prefix() {
  local s="$1"
  case "$s" in
    *"*"*|*"?"*)
      # Strip from the first segment containing a wildcard onward
      printf '%s\n' "${s%%/\**}" | sed 's:/$::'
      ;;
    *)
      printf '%s\n' "$s"
      ;;
  esac
}

for ref in "${REFS[@]}"; do
  # Strip leading/trailing punctuation that snuck through
  ref="${ref#[(\[]}"
  ref="${ref%[,.):\]]}"

  [[ -z "$ref" ]] && continue
  should_skip "$ref" && continue

  if is_package_like "$ref"; then
    # Check that any package.json in the repo declares this name
    if ! grep -rqE "\"name\":[[:space:]]*\"${ref}\"" --include=package.json . 2>/dev/null; then
      ERRORS+=("package not found in workspace: \`$ref\`")
    fi
    continue
  fi

  if is_path_like "$ref"; then
    resolved="$(resolve_glob_prefix "$ref")"
    case "$ref" in
      */)
        if [[ ! -d "${resolved%/}" ]]; then
          ERRORS+=("directory missing: \`$ref\`")
        fi
        ;;
      *)
        # Accept file OR directory (some refs omit trailing slash)
        if [[ ! -e "$resolved" ]]; then
          ERRORS+=("path missing: \`$ref\`")
        fi
        ;;
    esac
    continue
  fi

  # Anything else: not checked.
done

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "REVIEW.md cites paths/packages that no longer exist:"
  printf '  - %s\n' "${ERRORS[@]}"
  echo
  echo "Either restore the referenced paths or update .claude/REVIEW.md."
  exit 1
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo "Warnings:"
  printf '  - %s\n' "${WARNINGS[@]}"
fi

echo "REVIEW.md OK — ${#REFS[@]} backtick refs scanned, all cited paths/packages exist."
exit 0
