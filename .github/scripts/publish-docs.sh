#!/usr/bin/env bash
# Builds the content of the docs-live branch.
#
# Live docs = the release commit + every docs-only commit on main after it,
# applied in main order. A docs-only commit that conflicts or leaves a broken
# link is held ("waiting") until a later release includes it.
#
# The release commit is the newest accepted docs-release-* tag: a commit on
# main that isn't behind the current release, or a hotfix commit branched from
# the docs-live tip. Every run looks for new tags, so a tag run that was
# dropped or ran an older version of this workflow is picked up by the next run.
#
# Usage:
#   publish-docs.sh auto              build from the newest release that builds
#   publish-docs.sh preview <commit>  say whether merging <commit> goes live or waits
#   publish-docs.sh check-tag <tag>   fail unless the tag can be released
#   publish-docs.sh release           print the release commit to build from
#   publish-docs.sh build <release>   build the publish commit (no remote writes)
#
# build reports through RESULT_FILE (publish_sha=...), REPORT_FILE (markdown)
# and NEW_WAITING_FILE (one "<sha>\t<reason>" per commit that just started waiting).

set -euo pipefail

DOCS_LIVE_REF="${DOCS_LIVE_REF:-origin/docs-live}"
MAIN_REF="${MAIN_REF:-origin/main}"
DOCS_DIR="${DOCS_DIR:-docs}"
TAG_PATTERN="${TAG_PATTERN:-refs/tags/docs-release-*}"
LINK_CHECK_CMD="${LINK_CHECK_CMD:-npx --yes mintlify@4.0.393 broken-links}"
RESULT_FILE="${RESULT_FILE:-/dev/null}"
REPORT_FILE="${REPORT_FILE:-/dev/null}"
NEW_WAITING_FILE="${NEW_WAITING_FILE:-/dev/null}"

die() {
  echo "error: $*" >&2
  exit 1
}

is_ancestor() { git merge-base --is-ancestor "$1" "$2"; }

trailer_values() {
  git log -1 --format='%(trailers:key='"$2"',valueonly)' "$1" | sed '/^$/d'
}

live_tip() { git rev-parse "$DOCS_LIVE_REF^{commit}"; }

# The release recorded on docs-live, or the tip itself before the first run.
recorded_release() {
  local tip release
  tip=$(live_tip)
  release=$(trailer_values "$tip" Docs-Release | head -n1)
  echo "${release:-$tip}"
}

# Why a tag can't become the release, or nothing when it can.
tag_problem() {
  local tag="$1" release live base
  release=$(recorded_release)
  live=$(live_tip)
  if is_ancestor "$tag" "$MAIN_REF"; then
    base=$(git merge-base "$release" "$MAIN_REF")
    is_ancestor "$base" "$tag" ||
      echo "it is older than the current release $release, so publishing it would remove live docs. Tag $base or a later commit on main."
    return 0
  fi
  is_ancestor "$live" "$tag" ||
    echo "it is neither on main nor branched from the docs-live tip $live."
}

check_tag() {
  local tag problem
  tag=$(git rev-parse "$1^{commit}")
  if [[ "$tag" == "$(recorded_release)" ]]; then
    echo "$tag is already the release" >&2
    return 0
  fi
  problem=$(tag_problem "$tag")
  [[ -z "$problem" ]] || die "can't release $tag: $problem"
}

# Newest valid docs-release-* tag that isn't published yet, else the recorded release.
release() {
  local live release tag sha
  live=$(live_tip)
  release=$(recorded_release)
  is_ancestor "$release" "$MAIN_REF" || is_ancestor "$release" "$live" ||
    die "recorded release $release is neither on $MAIN_REF nor in docs-live"
  while IFS= read -r tag; do
    sha=$(git rev-parse "$tag^{commit}")
    is_ancestor "$sha" "$live" && continue
    [[ -z "$(tag_problem "$sha")" ]] || continue
    if [[ "$release" != "$(recorded_release)" ]] && is_ancestor "$sha" "$release"; then
      continue
    fi
    release="$sha"
  done < <(git for-each-ref --sort=creatordate --format='%(refname)' "$TAG_PATTERN")
  echo "$release"
}

is_docs_only() {
  local sha="$1" parents files path
  parents=$(git rev-list --parents -n1 "$sha" | wc -w)
  [[ "$parents" -eq 2 ]] || return 1
  files=$(git diff-tree --no-commit-id --name-only -r "$sha")
  [[ -n "$files" ]] || return 1
  while IFS= read -r path; do
    [[ "$path" == "$DOCS_DIR/"* ]] || return 1
  done <<<"$files"
}

WORK=""
cleanup() {
  if [[ -n "$WORK" ]]; then
    git worktree remove --force "$WORK" >/dev/null 2>&1 || true
  fi
}

in_work() {
  git -C "$WORK" -c user.name=docs-publish -c user.email=docs-publish@localhost "$@"
}

links_ok() {
  (cd "$WORK/$DOCS_DIR" && bash -c "$LINK_CHECK_CMD") >&2
}

contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

# Rebuilds the scratch tree from the release, skipping HELD commits.
# Sets INCLUDED, CONFLICTED and CONFLICT_FILES.
replay() {
  local sha files
  INCLUDED=()
  CONFLICTED=()
  CONFLICT_FILES=()
  in_work reset -q --hard "$RELEASE"
  for sha in "${CANDIDATES[@]+"${CANDIDATES[@]}"}"; do
    if contains "$sha" "${ALREADY[@]+"${ALREADY[@]}"}"; then
      INCLUDED+=("$sha")
      continue
    fi
    contains "$sha" "${HELD[@]+"${HELD[@]}"}" && continue
    if in_work cherry-pick --allow-empty --keep-redundant-commits "$sha" >/dev/null 2>&1; then
      INCLUDED+=("$sha")
      continue
    fi
    files=$(in_work diff --name-only --diff-filter=U | paste -sd, -)
    in_work cherry-pick --abort >/dev/null 2>&1 || in_work reset -q --hard
    CONFLICTED+=("$sha")
    CONFLICT_FILES+=("${files:-unknown}")
  done
}

without() {
  local drop="$1" item
  for item in "${HELD[@]+"${HELD[@]}"}"; do
    [[ "$item" == "$drop" ]] || echo "$item"
  done
}

# Holds docs-only commits until the links pass, picking from what the last
# rebuild applied: newest not-yet-live commits first, then live ones. Then gives
# held commits another try, oldest first, until a full pass changes nothing.
hold_until_links_pass() {
  local -a previously_live=()
  local sha
  while IFS= read -r sha; do
    [[ -n "$sha" ]] && previously_live+=("$sha")
  done < <(trailer_values "$LIVE" Docs-Included)

  while true; do
    local next="" fallback="" i
    for ((i = ${#INCLUDED[@]} - 1; i >= 0; i--)); do
      sha="${INCLUDED[$i]}"
      contains "$sha" "${ALREADY[@]+"${ALREADY[@]}"}" && continue
      if contains "$sha" "${previously_live[@]+"${previously_live[@]}"}"; then
        [[ -n "$fallback" ]] || fallback="$sha"
      else
        next="$sha"
        break
      fi
    done
    next="${next:-$fallback}"
    [[ -n "$next" ]] || die "the docs at release $RELEASE have broken links"
    HELD+=("$next")
    replay
    links_ok && break
  done

  local last="${HELD[${#HELD[@]}-1]}" changed=true
  while $changed; do
    changed=false
    for sha in "${CANDIDATES[@]}"; do
      [[ "$sha" != "$last" ]] || continue
      contains "$sha" "${HELD[@]}" || continue
      local -a saved=("${HELD[@]}") rest=()
      while IFS= read -r i; do
        [[ -n "$i" ]] && rest+=("$i")
      done < <(without "$sha")
      HELD=("${rest[@]+"${rest[@]}"}")
      replay
      if links_ok; then
        changed=true
      else
        HELD=("${saved[@]}")
      fi
    done
  done
  replay
}

build() {
  RELEASE=$(git rev-parse "$1^{commit}")
  LIVE=$(live_tip)

  WORK=$(mktemp -d)
  rmdir "$WORK"
  trap cleanup EXIT
  git worktree add -q --detach "$WORK" "$RELEASE"

  CANDIDATES=()
  HELD=()
  ALREADY=()
  local sha
  local baseline=""
  if [[ "$RELEASE" == "$(trailer_values "$LIVE" Docs-Release | head -n1)" ]]; then
    baseline=$(trailer_values "$LIVE" Docs-Baseline)
  elif [[ "$RELEASE" != "$LIVE" ]] && is_ancestor "$LIVE" "$RELEASE"; then
    baseline=$(trailer_values "$LIVE" Docs-Included; trailer_values "$LIVE" Docs-Baseline)
  fi
  while IFS= read -r sha; do
    [[ -n "$sha" ]] && ALREADY+=("$sha")
  done <<<"$baseline"
  while IFS= read -r sha; do
    [[ -n "$sha" ]] || continue
    is_docs_only "$sha" && CANDIDATES+=("$sha")
  done < <(git rev-list --reverse "$RELEASE..$MAIN_REF")

  replay
  links_ok || hold_until_links_pass

  WAITING=()
  REASONS=()
  local i
  for i in "${!CONFLICTED[@]}"; do
    WAITING+=("${CONFLICTED[$i]}")
    REASONS+=("conflict: ${CONFLICT_FILES[$i]}")
  done
  for sha in "${HELD[@]+"${HELD[@]}"}"; do
    WAITING+=("$sha")
    REASONS+=("broken-link")
  done

  publish
}

publish() {
  local tree previous_waiting new_waiting="" i sha short msg
  tree=$(git -C "$WORK" rev-parse 'HEAD^{tree}')
  previous_waiting=$(trailer_values "$LIVE" Docs-Waiting | awk '{print $1}')

  short=$(git rev-parse --short "$RELEASE")
  msg="docs: publish $short + ${#INCLUDED[@]} docs-only commit(s)"$'\n\n'"Docs-Release: $RELEASE"
  for sha in "${ALREADY[@]+"${ALREADY[@]}"}"; do
    msg+=$'\n'"Docs-Baseline: $sha"
  done
  for sha in "${INCLUDED[@]+"${INCLUDED[@]}"}"; do
    contains "$sha" "${ALREADY[@]+"${ALREADY[@]}"}" || msg+=$'\n'"Docs-Included: $sha"
  done
  for i in "${!WAITING[@]}"; do
    msg+=$'\n'"Docs-Waiting: ${WAITING[$i]} ${REASONS[$i]}"
    if ! grep -qx "${WAITING[$i]}" <<<"$previous_waiting"; then
      new_waiting+="${WAITING[$i]}"$'\t'"${REASONS[$i]}"$'\n'
    fi
  done

  write_report

  local live_release this_waiting
  live_release=$(trailer_values "$LIVE" Docs-Release | head -n1)
  this_waiting=$(printf '%s\n' "${WAITING[@]+"${WAITING[@]}"}" | sed '/^$/d' | sort)
  if [[ "$tree" == "$(git rev-parse "$LIVE^{tree}")" &&
    "$RELEASE" == "${live_release:-$LIVE}" &&
    "$this_waiting" == "$(sed '/^$/d' <<<"$previous_waiting" | sort)" ]]; then
    echo "publish_sha=" >>"$RESULT_FILE"
    echo "nothing to publish" >&2
    return 0
  fi

  local -a parents=(-p "$LIVE")
  if is_ancestor "$LIVE" "$RELEASE"; then
    parents=(-p "$RELEASE")
  elif ! is_ancestor "$RELEASE" "$LIVE"; then
    parents+=(-p "$RELEASE")
  fi

  local commit
  commit=$(git -c user.name=docs-publish -c user.email=docs-publish@users.noreply.github.com \
    commit-tree "$tree" "${parents[@]}" -m "$msg")
  echo "publish_sha=$commit" >>"$RESULT_FILE"
  if [[ -n "$live_release" ]]; then
    printf '%s' "$new_waiting" >>"$NEW_WAITING_FILE"
  fi
  echo "$commit"
}

write_report() {
  local sha i
  {
    echo "### Docs publish"
    echo
    echo "Release commit: \`$RELEASE\` $(git log -1 --format=%s "$RELEASE")"
    echo
    echo "**Docs-only commits published since the release:** ${#INCLUDED[@]}"
    for sha in "${INCLUDED[@]+"${INCLUDED[@]}"}"; do
      echo "- \`${sha:0:9}\` $(git log -1 --format=%s "$sha")"
    done
    echo
    echo "**Waiting for the next docs release:** ${#WAITING[@]}"
    for i in "${!WAITING[@]}"; do
      echo "- \`${WAITING[$i]:0:9}\` $(git log -1 --format=%s "${WAITING[$i]}") (${REASONS[$i]})"
    done
  } >>"$REPORT_FILE"
}

# Builds from the newest accepted release. If that release can't be built (for
# example a tag with broken links), falls back to the recorded release so
# docs-only changes keep publishing, and warns.
auto() {
  local release recorded
  release=$(release)
  recorded=$(recorded_release)
  if "$0" build "$release"; then
    return 0
  fi
  [[ "$release" != "$recorded" ]] || die "the recorded release $recorded can't be built"
  echo "::warning::Release $release can't be published (see the error above). Published docs-only changes on top of $recorded instead."
  "$0" build "$recorded"
}

# Predicts what merging a commit does, treating it as the tip of main. Prints one line:
# "live", "waiting<TAB><reason>" or "tag" (not docs-only, waits for a release tag).
preview() {
  local sha out publish reason
  sha=$(git rev-parse "$1^{commit}")
  if ! is_docs_only "$sha"; then
    echo "tag"
    return 0
  fi
  out=$(MAIN_REF="$sha" RESULT_FILE=/dev/null REPORT_FILE=/dev/null NEW_WAITING_FILE=/dev/null "$0" auto 2>/dev/null) ||
    die "couldn't build the docs to preview"
  publish=$(grep -E '^[0-9a-f]{40}$' <<<"$out" | tail -n1 || true)
  if [[ -z "$publish" ]]; then
    echo "live"
    return 0
  fi
  reason=$(trailer_values "$publish" Docs-Waiting | awk -v s="$sha" '$1 == s { $1 = ""; sub(/^ /, ""); print; exit }')
  if [[ -n "$reason" ]]; then
    printf 'waiting\t%s\n' "$reason"
  else
    echo "live"
  fi
}

case "${1:-}" in
auto) auto ;;
preview)
  [[ $# -eq 2 ]] || die "usage: $0 preview <commit>"
  preview "$2"
  ;;
check-tag)
  [[ $# -eq 2 ]] || die "usage: $0 check-tag <tag>"
  check_tag "$2"
  ;;
release) release ;;
build)
  [[ $# -eq 2 ]] || die "usage: $0 build <release>"
  build "$2"
  ;;
*) die "usage: $0 auto | preview <commit> | check-tag <tag> | release | build <release>" ;;
esac
