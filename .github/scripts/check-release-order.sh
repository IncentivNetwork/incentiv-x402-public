#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

deployment=$(cat)
rollback_from=${ROLLBACK_FROM:-}
if [[ "$ROLLBACK" == true ]]; then
  [[ -n "$rollback_from" ]] || fail 'Set rollback_from to the inspected Deployment UID:generation'
  revision=$(jq -er '
    .metadata | select((.uid | type) == "string" and .uid != "" and (.generation | type) == "number" and .generation >= 1)
    | "\(.uid):\(.generation)"
  ' <<< "$deployment") || fail 'Cannot determine the current Deployment UID and generation'
  [[ "$rollback_from" == "$revision" ]] || fail 'Deployment no longer matches rollback_from. Inspect the current release before requesting another rollback.'
elif [[ -n "$rollback_from" ]]; then
  fail 'rollback_from requires rollback: true'
fi

highest=$(jq -r '.metadata.annotations["x402.incentiv.io/highest-release"] // empty' <<< "$deployment")
newest=$(jq -r '.metadata.annotations["x402.incentiv.io/newest-release-commit"] // empty' <<< "$deployment")

version='(0|[1-9][0-9]*)'
if [[ -n "$highest" && ! "$highest" =~ ^v$version\.$version\.$version$ ]]; then
  fail 'Invalid x402.incentiv.io/highest-release annotation on the Deployment'
fi
if [[ -n "$newest" && ( ! "$newest" =~ ^[0-9a-f]{40}$ || -z "$highest" ) ]]; then
  fail 'Invalid x402.incentiv.io/newest-release-commit annotation on the Deployment'
fi
if [[ -z "$newest" && -n "$highest" ]]; then
  newest=$(git rev-parse --verify "refs/tags/$highest^{commit}") || fail "Cannot resolve $highest. Record the verified source commit on the Deployment."
fi

next_highest=$(printf '%s\n' "$highest" "$TAG" | LC_ALL=C sort -V | tail -n 1)
next_newest=$COMMIT
if [[ -n "$newest" ]] && ! git merge-base --is-ancestor "$newest" "$COMMIT"; then
  git merge-base --is-ancestor "$COMMIT" "$newest" || fail "Cannot establish release ancestry between $COMMIT and $newest"
  next_newest=$newest
fi

if [[ "$TAG" == "$next_highest" && "$COMMIT" == "$next_newest" ]]; then
  [[ "$ROLLBACK" != true ]] || fail 'A rollback must select an older release version or source commit'
else
  [[ "$ROLLBACK" == true ]] || fail "$TAG ($COMMIT) would downgrade the release version or source. Set rollback to true for an intentional downgrade."
fi

jq -cn --arg highest "$next_highest" --arg newest "$next_newest" '{
  "x402.incentiv.io/highest-release": $highest,
  "x402.incentiv.io/newest-release-commit": $newest
}'
