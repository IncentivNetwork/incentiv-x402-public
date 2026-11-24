#!/usr/bin/env bash
set -euo pipefail

validator="$(pwd -P)/.github/scripts/check-release-order.sh"
temp_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
fixture=$(mktemp -d "$temp_root/x402-release-order.XXXXXXXX")
cleanup() {
  case "$(realpath "$fixture")" in
    "$temp_root"/x402-release-order.*) cd "$temp_root" && rm -rf -- "$fixture" ;;
  esac
}
trap cleanup EXIT
cd "$fixture"
git init -q -b main

commit() {
  git -c user.name=Test -c user.email=test@example.test -c commit.gpgsign=false commit -q --allow-empty -m "$1"
  git rev-parse HEAD
}

old=$(commit old)
middle=$(commit middle)
current=$(commit current)
next=$(commit next)
git tag v1.2.0 "$current"
git checkout -q --detach "$old"
divergent=$(commit divergent)

check() {
  local scenario=$1 tag=$2 commit=$3 rollback=$4 highest=$5 newest=$6 next_highest=$7 next_newest=${8:-}
  local deployment result status=0
  deployment=$(jq -cn --arg highest "$highest" --arg newest "$newest" '{metadata:{annotations:{
    "x402.incentiv.io/highest-release":$highest,
    "x402.incentiv.io/newest-release-commit":$newest
  }}}')
  result=$(TAG=$tag COMMIT=$commit ROLLBACK=$rollback bash "$validator" <<< "$deployment" 2>&1) || status=$?
  if [[ -z "$next_highest" ]]; then
    [[ $status != 0 && "$result" == *'::error::'* ]] || { printf '%s unexpectedly passed\n%s\n' "$scenario" "$result" >&2; return 1; }
  else
    [[ $status == 0 ]] && jq -e --arg highest "$next_highest" --arg newest "$next_newest" '. == {
      "x402.incentiv.io/highest-release":$highest,
      "x402.incentiv.io/newest-release-commit":$newest
    }' <<< "$result" >/dev/null || { printf '%s failed\n%s\n' "$scenario" "$result" >&2; return 1; }
  fi
  printf 'Passed %s\n' "$scenario"
}

check 'first release' v1.0.0 "$old" false '' '' v1.0.0 "$old"
check 'forward release' v1.3.0 "$next" false v1.2.0 "$current" v1.3.0 "$next"
check 'retry of the same release' v1.2.0 "$current" false v1.2.0 "$current" v1.2.0 "$current"
check 'higher version at the same commit' v1.3.0 "$current" false v1.2.0 "$current" v1.3.0 "$current"
check 'new tag on an older commit' v1.3.0 "$old" false v1.2.0 "$current" ''
check 'lower version on a newer commit' v1.1.0 "$next" false v1.2.0 "$current" ''
check 'intentional rollback preserves both annotations' v1.0.0 "$old" true v1.2.0 "$current" v1.2.0 "$current"
check 'intentional source rollback keeps the newer commit' v1.3.0 "$old" true v1.2.0 "$current" v1.3.0 "$current"
check 'intentional version rollback records the newer commit' v1.1.0 "$next" true v1.2.0 "$current" v1.2.0 "$next"
check 'a queued older commit still fails after rollback' v1.3.0 "$middle" false v1.2.0 "$current" ''
check 'forward release with rollback flag' v1.3.0 "$next" true v1.2.0 "$current" ''
check 'existing version without a source annotation' v1.2.0 "$current" false v1.2.0 '' v1.2.0 "$current"
check 'legacy annotation protects against an older commit' v1.3.0 "$old" false v1.2.0 '' ''
check 'unresolvable legacy annotation' v1.3.0 "$next" false v1.2.1 '' ''
check 'malformed source annotation' v1.3.0 "$next" false v1.2.0 invalid ''
check 'explicit rollback to a shared ancestor' v1.0.0 "$old" true v1.2.0 "$divergent" v1.2.0 "$divergent"
check 'divergent source commit fails even for rollback' v1.0.0 "$divergent" true v1.2.0 "$current" ''
