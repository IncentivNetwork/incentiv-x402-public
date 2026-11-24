#!/usr/bin/env bash
set -euo pipefail

test_dir=$(mktemp -d)
trap 'rm -f -- "$test_dir/output" "$test_dir/calls"; rmdir -- "$test_dir"' EXIT
export GITHUB_OUTPUT="$test_dir/output"
export CALLS="$test_dir/calls"
export AWS_REGION=us-east-1 ECR_REPOSITORY=facilitator TAG=v1.2.3
export GITHUB_REPOSITORY_ID=10 GITHUB_RUN_ID=20 GITHUB_RUN_ATTEMPT=1
COMMIT=$(git rev-parse HEAD)
DIGEST="sha256:$(printf '%064d' 1)"
OTHER_DIGEST="sha256:$(printf '%064d' 2)"
export COMMIT DIGEST

aws() {
  printf '%s %s\n' "$1" "$2" >> "$CALLS"
  case "$1 $2" in
    'sts get-caller-identity') echo 123456789012 ;;
    'ecr batch-get-image')
      if [[ "$6" == "imageTag=$TAG" && -z "$TAG_DIGEST" ]]; then
        echo '{"images":[],"failures":[{"failureCode":"ImageNotFound"}]}'
      elif [[ "$6" == "imageTag=$TAG" ]]; then
        jq -cn --arg digest "$TAG_DIGEST" '{images:[{imageId:{imageDigest:$digest}}]}'
      else
        [[ "$6" == "imageDigest=$DIGEST" ]] || return 1
        jq -cn --arg digest "$DIGEST" '{images:[{imageId:{imageDigest:$digest},imageManifest:"{}"}]}'
      fi ;;
    'ssm get-parameters')
      if [[ "$RECORD" == unavailable ]]; then
        echo 'AccessDeniedException' >&2
        return 1
      fi
      printf '%s\n' "$RECORD" ;;
    'ssm put-parameter')
      [[ "$4" == "/x402/releases/$ECR_REPOSITORY/$TAG" && "$9" == --no-overwrite ]] || return 1
      jq -e --arg commit "$COMMIT" --arg digest "$DIGEST" '. == {commit:$commit,digest:$digest}' <<< "$8" ;;
    'ecr get-login-password') echo test-password ;;
    'ecr put-image')
      [[ "$6" == "$TAG" && "$8" == "$DIGEST" && $(cat "${10#file://}") == '{}' ]] ;;
    *) return 1 ;;
  esac
}

docker() {
  printf 'docker %s\n' "$1" >> "$CALLS"
  case "$1" in
    login) cat >/dev/null ;;
    buildx)
      [[ "$9" == "org.opencontainers.image.revision=$COMMIT" && "${10}" == --tag ]] || return 1
      [[ "${11}" == */facilitator:candidate-10-20-1 && "${12}" == . ]] || return 1
      jq -cn --arg digest "$DIGEST" '{"containerimage.digest":$digest}' > "$7" ;;
    logout) ;;
    *) return 1 ;;
  esac
}
export -f aws docker

record_for() {
  jq -cn --arg commit "$1" --arg digest "$DIGEST" '{commit:$commit,digest:$digest} | tojson'
}

check() {
  local scenario=$1 expected=$2 expected_writes=$3
  export TAG_DIGEST=$4 RECORD=$5 ROLLBACK=${6:-false}
  : > "$CALLS"
  : > "$GITHUB_OUTPUT"
  local status=0 output
  output=$(bash .github/scripts/publish-facilitator.sh . 2>&1) || status=$?
  if [[ "$expected" == success ]]; then
    [[ $status == 0 && $(cat "$GITHUB_OUTPUT") == "ref=123456789012.dkr.ecr.us-east-1.amazonaws.com/facilitator@$DIGEST" ]] || {
      printf '%s failed (%s)\n%s\n' "$scenario" "$status" "$output" >&2
      return 1
    }
  else
    [[ $status != 0 && ! -s "$GITHUB_OUTPUT" && "$output" == *"$expected"* ]] || {
      printf '%s unexpectedly returned %s\n%s\n' "$scenario" "$status" "$output" >&2
      return 1
    }
  fi
  local writes
  writes=$(sed -n -e '/^ssm put-parameter$/p' -e '/^ecr put-image$/p' -e '/^docker buildx$/p' "$CALLS")
  [[ "$writes" == "$expected_writes" ]] || { printf '%s made unexpected writes\n%s\n' "$scenario" "$writes" >&2; return 1; }
  printf 'Passed %s\n' "$scenario"
}

verified=$(record_for "$COMMIT")
check 'verified reuse' success '' "$DIGEST" "$verified"
check 'verified rollback' success '' "$DIGEST" "$verified" true
check 'legacy image' 'no trusted release record' '' "$DIGEST" null
check 'rollback of legacy image' 'no trusted release record' '' "$DIGEST" null true
check 'wrong source commit' 'does not identify an image from the tested commit' '' "$DIGEST" "$(record_for other)"
check 'wrong tag digest on rollback' 'does not match the trusted release digest' '' "$OTHER_DIGEST" "$verified" true
check 'no access to provenance' 'AccessDeniedException' '' "$DIGEST" unavailable
check 'missing rollback tag' 'No published ECR image' '' '' "$verified" true
check 'interrupted publication' success 'ecr put-image' '' "$verified"
check 'new publication' success $'docker buildx\nssm put-parameter\necr put-image' '' null
