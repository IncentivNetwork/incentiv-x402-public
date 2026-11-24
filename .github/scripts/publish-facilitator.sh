#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

source_dir=$1
[[ $(git -C "$source_dir" rev-parse HEAD) == "$COMMIT" ]] || fail 'Build checkout does not match the tested commit'

account=$(aws sts get-caller-identity --query Account --output text)
registry="$account.dkr.ecr.$AWS_REGION.amazonaws.com"
repository="$registry/$ECR_REPOSITORY"
parameter="/x402/releases/$ECR_REPOSITORY/$TAG"
digest_pattern='^sha256:[0-9a-f]{64}$'
temp_dir=$(mktemp -d)
trap 'rm -f -- "$temp_dir/build.json" "$temp_dir/manifest.json"; rmdir -- "$temp_dir"' EXIT

get_image() {
  aws ecr batch-get-image --repository-name "$ECR_REPOSITORY" --image-ids "$1" --output json
}

release_image=$(get_image "imageTag=$TAG")
tag_digest=$(jq -er --arg pattern "$digest_pattern" '
  if (.images | length) == 1 then
    .images[0].imageId.imageDigest | select(type == "string" and test($pattern))
  elif [.failures[].failureCode] == ["ImageNotFound"] then ""
  else error("Unexpected ECR response for the release tag")
  end
' <<< "$release_image")

record=$(aws ssm get-parameters --names "$parameter" --query 'Parameters[0].Value' --output json)
if [[ "$record" == null ]]; then
  [[ -z "$tag_digest" ]] || fail "Existing ECR image for $TAG has no trusted release record"
  [[ "$ROLLBACK" != true ]] || fail "No verified image for rollback to $TAG"

  # Push under a staging tag. Only publish the version tag after recording the digest from Buildx.
  candidate="candidate-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
  docker buildx build --pull --push --provenance=false --metadata-file "$temp_dir/build.json" \
    --label "org.opencontainers.image.revision=$COMMIT" --tag "$repository:$candidate" "$source_dir"
  docker logout "$registry"
  digest=$(jq -er --arg pattern "$digest_pattern" '
    .["containerimage.digest"] | select(type == "string" and test($pattern))
  ' "$temp_dir/build.json") || fail 'Buildx did not return a valid image digest'
  record=$(jq -cn --arg commit "$COMMIT" --arg digest "$digest" '{commit: $commit, digest: $digest}')
  aws ssm put-parameter --name "$parameter" --type String --value "$record" --no-overwrite >/dev/null
else
  digest=$(jq -er --arg commit "$COMMIT" --arg pattern "$digest_pattern" '
    fromjson | select(.commit == $commit) | .digest | select(type == "string" and test($pattern))
  ' <<< "$record") || fail "Release record for $TAG does not identify an image from the tested commit"
fi

if [[ -n "$tag_digest" ]]; then
  [[ "$tag_digest" == "$digest" ]] || fail "ECR image for $TAG does not match the trusted release digest"
else
  [[ "$ROLLBACK" != true ]] || fail "No published ECR image for rollback to $TAG"
  image=$(get_image "imageDigest=$digest")
  jq -jer --arg digest "$digest" '
    .images[0] | select(.imageId.imageDigest == $digest) | .imageManifest | select(type == "string" and length > 0)
  ' <<< "$image" > "$temp_dir/manifest.json" || fail "Recorded image for $TAG is missing from ECR"
  aws ecr put-image --repository-name "$ECR_REPOSITORY" --image-tag "$TAG" --image-digest "$digest" \
    --image-manifest "file://$temp_dir/manifest.json" >/dev/null
fi

printf 'ref=%s@%s\n' "$repository" "$digest" >> "$GITHUB_OUTPUT"
