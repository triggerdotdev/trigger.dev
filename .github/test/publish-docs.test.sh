#!/usr/bin/env bash
# Tests .github/scripts/publish-docs.sh against a throwaway repo.
# Run: bash .github/test/publish-docs.test.sh

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/publish-docs.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

cat >"$ROOT/check-links.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for page in $(grep -ohr '](/[a-z0-9-]*)' . | sed -E 's/^\]\(\/(.*)\)$/\1/' | sort -u); do
  [[ -f "$page.mdx" ]] || { echo "broken link: /$page"; exit 1; }
done
EOF
chmod +x "$ROOT/check-links.sh"

export DOCS_LIVE_REF=docs-live MAIN_REF=main LINK_CHECK_CMD="$ROOT/check-links.sh"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

REPO="$ROOT/repo"
git init -q -b main "$REPO"
cd "$REPO"

PASS=0
FAIL=0
check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok   - $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL - $name"
    FAIL=$((FAIL + 1))
  fi
}

commit() {
  local msg="$1"
  shift
  while [[ $# -gt 0 ]]; do
    mkdir -p "$(dirname "$1")"
    if [[ "$2" == "-" ]]; then
      git rm -q "$1"
    else
      printf '%s\n' "$2" >"$1"
      git add "$1"
    fi
    shift 2
  done
  git commit -q -m "$msg"
  git rev-parse HEAD
}

tag_count=0
tag() {
  tag_count=$((tag_count + 1))
  git tag -a "docs-release-test-$tag_count" "$1" -m release
  sleep 1
}

live_has() { git cat-file -e "docs-live:$1" 2>/dev/null; }
live_lacks() { ! live_has "$1"; }
live_file_is() { [[ "$(git show "docs-live:$1")" == "$2" ]]; }
waiting() { git log -1 --format='%(trailers:key=Docs-Waiting,valueonly)' docs-live | sed '/^$/d' | awk '{print $1}' | tr '\n' ' '; }
released() { git log -1 --format='%(trailers:key=Docs-Release,valueonly)' docs-live | sed '/^$/d'; }

RESULT="$ROOT/result"
NEW_WAITING="$ROOT/new-waiting"
REPORT="$ROOT/report"

# One workflow run: find the release, build, and fast-forward docs-live.
publish() {
  : >"$RESULT"
  : >"$NEW_WAITING"
  : >"$REPORT"
  local release sha
  release=$("$SCRIPT" release 2>/dev/null) || return 1
  RESULT_FILE="$RESULT" NEW_WAITING_FILE="$NEW_WAITING" REPORT_FILE="$REPORT" \
    "$SCRIPT" build "$release" >/dev/null 2>&1 || return 1
  sha=$(sed -n 's/^publish_sha=//p' "$RESULT")
  if [[ -n "$sha" ]]; then
    git merge-base --is-ancestor docs-live "$sha" || return 1
    git update-ref refs/heads/docs-live "$sha"
  fi
}
published_nothing() { [[ -z "$(sed -n 's/^publish_sha=//p' "$RESULT")" ]]; }
tag_ok() { "$SCRIPT" check-tag "$1" >/dev/null 2>&1; }
tag_refused() { ! tag_ok "$1"; }

NAV1='nav: index'
BASE=$(commit "initial" docs/index.mdx "# Home" docs/docs.json "$NAV1" docs/old.mdx "# Old" apps/app.ts "v1")
git branch docs-live "$BASE"

check "bootstrap: release is the docs-live tip" [ "$("$SCRIPT" release)" == "$BASE" ]

# Docs-only commits publish; feature docs wait.
A=$(commit "feat: feature A" apps/app.ts "v2" docs/feature.mdx "# Feature" docs/index.mdx "# Home v2")
B0=$(commit "docs: home typo" docs/index.mdx "# Home v2, fixed")
C=$(commit "docs: guide" docs/guide.mdx "# Guide")
publish
check "first run makes no commit comments" [ ! -s "$NEW_WAITING" ]
check "docs-only commit behind a feature commit is published" live_has docs/guide.mdx
check "feature commit's docs are not published" live_lacks docs/feature.mdx
check "conflicting docs-only commit waits" [ "$(waiting)" == "$B0 " ]
check "release recorded" [ "$(released)" == "$BASE" ]

publish
check "rerun with nothing new publishes nothing" published_nothing

D=$(commit "docs: d" docs/d.mdx "# D")
E=$(commit "docs: e" docs/e.mdx "# E")
publish
check "missed run catches up, in main order" \
  [ "$(git log -1 --format='%(trailers:key=Docs-Included,valueonly)' docs-live | sed '/^$/d' | tr '\n' ' ')" == "$C $D $E " ]

commit "feat: nav for B" apps/app.ts "v3" docs/docs.json "nav: index, b" >/dev/null
F=$(commit "docs: nav typo" docs/docs.json "nav: index, b, f")
commit "docs: g2" docs/g2.mdx "# G2" >/dev/null
publish
check "later docs-only commits still publish past a conflict" live_has docs/g2.mdx
check "newly waiting commit is reported" grep -q "^$F	conflict: docs/docs.json" "$NEW_WAITING"
publish
check "waiting commit isn't reported twice" [ ! -s "$NEW_WAITING" ]

# Broken links: hold the culprit, never die on its dependents, keep pairs together.
G=$(commit "docs: link to feature" docs/links.mdx "see [feature](/feature)")
H=$(commit "docs: extend broken guide" docs/links.mdx "see [feature](/feature) and more")
commit "docs: target page" docs/target.mdx "# Target" >/dev/null
commit "docs: guide linking to target" docs/q.mdx "see [target](/target)" >/dev/null
publish
check "broken-link commit waits" live_lacks docs/links.mdx
check "its dependent waits instead of failing the run" [ "$(waiting)" == "$B0 $F $H $G " ]
check "a guide and its target publish together" bash -c "git cat-file -e docs-live:docs/target.mdx && git cat-file -e docs-live:docs/q.mdx"
check "broken link reported" grep -q "^$G	broken-link" "$NEW_WAITING"

X=$(commit "docs: drop old page" docs/old.mdx - docs/legacy.mdx "see [old](/old)")
publish
check "removing a page that live docs link to waits" live_has docs/old.mdx
check "already-live docs stay live" bash -c "git cat-file -e docs-live:docs/q.mdx && git cat-file -e docs-live:docs/guide.mdx"
check "removal reported as broken-link" grep -q "^$X	broken-link" "$NEW_WAITING"

commit "docs: fix links" docs/links.mdx "see [guide](/guide)" docs/legacy.mdx "gone" >/dev/null
publish
check "fix merges: the waiting commits and the fix go live" live_file_is docs/links.mdx "see [guide](/guide)"
check "fix merges: the removal goes live" live_lacks docs/old.mdx
check "fix merges: only the conflicts still wait" [ "$(waiting)" == "$B0 $F " ]

# Tags.
T=$(git rev-parse HEAD)
commit "feat: feature K" apps/app.ts "v4" docs/k.mdx "# K" >/dev/null
commit "docs: j" docs/j.mdx "# J" >/dev/null
publish
check "tag on an earlier commit passes the guard" tag_ok "$T"
tag "$T"
publish
check "tag earlier: release moves to the tag" [ "$(released)" == "$T" ]
check "tag earlier: later docs-only commit stays live" live_has docs/j.mdx
check "tag earlier: feature docs before the tag go live" live_has docs/feature.mdx
check "tag earlier: waiting commits go live with the tag" live_file_is docs/docs.json "nav: index, b, f"
check "tag earlier: feature docs after the tag stay unpublished" live_lacks docs/k.mdx
check "tagged commit is part of docs-live history" git merge-base --is-ancestor "$T" docs-live

check "tag older than the current release is refused" tag_refused "$A"
git checkout -q -b side "$T"
SIDE=$(commit "side" docs/side.mdx "# Side")
git checkout -q main
check "tag neither on main nor from docs-live is refused" tag_refused "$SIDE"
tag "$SIDE"
tag "$A"
publish
check "invalid tags are ignored by later runs" [ "$(released)" == "$T" ]

# A tag run that never happened (dropped, or ran an old workflow) is picked up.
T2=$(commit "feat: feature L" apps/app.ts "v5" docs/l.mdx "# L")
tag "$T2"
commit "docs: m" docs/m.mdx "# M" >/dev/null
publish
check "a dropped tag run is picked up by the next run" [ "$(released)" == "$T2" ]
check "its docs go live" live_has docs/l.mdx

# Hotfix during an outbound hold: tag a commit branched from docs-live.
commit "docs: z" docs/z.mdx "z v0" >/dev/null
commit "docs: z edit" docs/z.mdx "z v1" >/dev/null
publish
git checkout -q -b hotfix docs-live
HOT=$(commit "docs: runtime table" docs/runtime.mdx "node 24.1" docs/z.mdx "z v0")
git checkout -q main
check "hotfix tag branched from docs-live passes the guard" tag_ok "$HOT"
tag "$HOT"
publish
check "hotfix is live" live_file_is docs/runtime.mdx "node 24.1"
check "hotfix: release is the hotfix commit" [ "$(released)" == "$HOT" ]
check "hotfix: no false waiting from replaying live commits" [ "$(waiting)" == "" ]
commit "docs: n" docs/n.mdx "# N" >/dev/null
publish
check "hotfix stays live after a docs-only merge" live_file_is docs/runtime.mdx "node 24.1"
check "a docs-only merge doesn't undo a hotfix revert" live_file_is docs/z.mdx "z v0"
check "no false waiting after the hotfix" [ "$(waiting)" == "" ]
commit "docs: n2" docs/n2.mdx "# N2" >/dev/null
publish
check "the hotfix revert survives a second docs-only merge" live_file_is docs/z.mdx "z v0"
check "docs-only merge after the hotfix publishes" live_has docs/n.mdx
PINS=$(commit "feat: cli pins" apps/app.ts "v6" docs/runtime.mdx "node 24.1")
check "main tag after the hotfix passes the guard" tag_ok "$PINS"
tag "$PINS"
publish
check "main tag after the hotfix becomes the release" [ "$(released)" == "$PINS" ]
check "main tag after the hotfix keeps the table" live_file_is docs/runtime.mdx "node 24.1"

# A tag with a broken link that a later docs-only commit repairs.
TB=$(commit "feat: broken" apps/app.ts "v7" docs/bad.mdx "[x](/nope)")
commit "docs: repair" docs/bad.mdx "fixed" >/dev/null
tag "$TB"
publish
check "broken tag repaired by a later docs-only commit publishes" live_file_is docs/bad.mdx "fixed"
Y=$(commit "docs: new broken" docs/y.mdx "[y](/nowhere)")
publish
check "a later broken commit waits without dropping the repair" bash -c "[ \"\$(git show docs-live:docs/bad.mdx)\" == fixed ] && ! git cat-file -e docs-live:docs/y.mdx"
check "only the new broken commit waits" [ "$(waiting)" == "$Y " ]

# A tag whose own docs are broken fails and changes nothing.
TB2=$(commit "feat: broken again" apps/app.ts "v8" docs/bad2.mdx "[x](/nope)")
before=$(git rev-parse docs-live)
check "tagged commit with broken links fails" bash -c "! RESULT_FILE=/dev/null '$SCRIPT' build '$TB2' >/dev/null 2>&1"
check "failed run leaves docs-live alone" [ "$(git rev-parse docs-live)" == "$before" ]

FIX=$(commit "feat: fix" docs/bad2.mdx "fixed" docs/y.mdx "fixed")
tag "$FIX"
publish
check "tagging main: live docs equal main's docs" [ "$(git rev-parse docs-live:docs)" == "$(git rev-parse main:docs)" ]

# Link fallback: a guide merged before the page it links to still publishes.
commit "docs: broken x1" docs/x1.mdx "[x](/nowhere1)" >/dev/null
commit "docs: guide g1" docs/g1.mdx "see [t](/tgt1)" >/dev/null
commit "docs: target t1" docs/tgt1.mdx "# T1" >/dev/null
publish
check "a guide merged before its target publishes with it" bash -c "git cat-file -e docs-live:docs/g1.mdx && git cat-file -e docs-live:docs/tgt1.mdx"
check "the unrelated broken commit waits" live_lacks docs/x1.mdx
commit "docs: fix x1" docs/x1.mdx "fixed" >/dev/null
publish

# Link fallback: a commit that only applies once another is held is also considered.
INDEX=$(git show main:docs/index.mdx)
commit "docs: broken x2" docs/x2.mdx "[x](/nowhere2)" >/dev/null
commit "docs: p1" docs/index.mdx "P1 text" >/dev/null
commit "feat: restore index" apps/app.ts "v9" docs/index.mdx "$INDEX" >/dev/null
commit "docs: p2" docs/index.mdx "[p](/missing-p)" >/dev/null
check "a commit unblocked by holding another doesn't fail the run" publish
check "the safe edit still publishes" live_file_is docs/index.mdx "P1 text"
check "the broken commits wait" live_lacks docs/x2.mdx
commit "docs: fix x2" docs/x2.mdx "fixed" >/dev/null
FIX2=$(commit "feat: fix index" apps/app.ts "v10" docs/index.mdx "fixed")
tag "$FIX2"
publish

# A tag that can't be built doesn't block docs-only publishing.
TBX=$(commit "feat: broken tag" apps/app.ts "v11" docs/bx.mdx "[x](/nowhere3)")
tag "$TBX"
commit "docs: after the broken tag" docs/after.mdx "# After" >/dev/null
: >"$RESULT"
check "auto falls back to the recorded release" bash -c "RESULT_FILE='$RESULT' NEW_WAITING_FILE=/dev/null REPORT_FILE=/dev/null '$SCRIPT' auto 2>/dev/null | grep -q '::warning::'"
git update-ref refs/heads/docs-live "$(sed -n 's/^publish_sha=//p' "$RESULT" | tail -1)"
check "docs-only commit publishes despite the broken tag" live_has docs/after.mdx
check "the broken tag isn't released" [ "$(released)" == "$FIX2" ]
check "building the broken tag itself still fails" bash -c "! RESULT_FILE=/dev/null '$SCRIPT' build '$TBX' >/dev/null 2>&1"

# Preview: what merging a PR would do, without touching docs-live.
preview() { MAIN_REF="$1" "$SCRIPT" preview "$1" 2>/dev/null; }
before=$(git rev-parse docs-live)
git checkout -q -b pv-live main
PV1=$(commit "docs: preview live" docs/pv1.mdx "# PV1")
check "preview: a docs-only PR goes live" [ "$(preview "$PV1")" == "live" ]
git checkout -q main
commit "feat: nav change" apps/app.ts "v12" docs/docs.json "nav: unreleased" >/dev/null
git checkout -q -b pv-wait main
PV2=$(commit "docs: nav tweak" docs/docs.json "nav: tweaked")
check "preview: a conflicting docs-only PR waits, with the reason" \
  [ "$(preview "$PV2")" == "$(printf 'waiting\tconflict: docs/docs.json')" ]
git checkout -q -b pv-tag main
PV3=$(commit "feat: code and docs" apps/app.ts "v13" docs/pv3.mdx "# PV3")
check "preview: a PR with code waits for a tag" [ "$(preview "$PV3")" == "tag" ]
git checkout -q main
check "preview leaves docs-live alone" [ "$(git rev-parse docs-live)" == "$before" ]
git checkout -q -b pv-noid main
PV4=$(commit "docs: preview without identity" docs/pv4.mdx "# PV4")
git checkout -q main
mkdir -p "$ROOT/nohome"
check "preview works with no git identity configured" [ "$(env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
  HOME="$ROOT/nohome" XDG_CONFIG_HOME="$ROOT/nohome" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null MAIN_REF="$PV4" \
  "$SCRIPT" preview "$PV4" 2>/dev/null)" == "live" ]
check "preview uses the given commit even when MAIN_REF points elsewhere" \
  [ "$(MAIN_REF=main "$SCRIPT" preview "$PV2" 2>/dev/null)" == "$(printf 'waiting\tconflict: docs/docs.json')" ]

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
