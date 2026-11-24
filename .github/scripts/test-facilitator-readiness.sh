#!/usr/bin/env bash
set -euo pipefail

container='{"readinessProbe":{"httpGet":{"path":"/health","port":4020},"timeoutSeconds":25}}'

check() {
  local scenario=$1 expected=$2 filter=$3 actual=reject fixture
  fixture=$(jq -c "$filter" <<< "$container")
  if jq -e -f .github/scripts/validate-facilitator-readiness.jq <<< "$fixture" >/dev/null; then
    actual=accept
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf '%s: expected %s, got %s\n' "$scenario" "$expected" "$actual" >&2
    return 1
  fi
  printf 'Passed %s\n' "$scenario"
}

check 'default listening port' accept '.'
check 'literal custom port overrides envFrom' accept '
  .envFrom = [{configMapRef:{name:"config"}}]
  | .env = [{name:"PORT",value:"8080"}] | .readinessProbe.httpGet.port = 8080'
check 'empty PORT uses the default' accept '.env = [{name:"PORT",value:""}]'
check 'named TCP port on the facilitator' accept '
  .readinessProbe.httpGet.port = "http" | .ports = [{name:"http",containerPort:4020}]'
check 'another container port' reject '.readinessProbe.httpGet.port = 8080'
check 'wrong custom listening port' reject '.env = [{name:"PORT",value:"8080"}]'
check 'name maps to the wrong port' reject '
  .readinessProbe.httpGet.port = "http" | .ports = [{name:"http",containerPort:8080}]'
check 'name is available only on a sidecar' reject '.readinessProbe.httpGet.port = "sidecar"'
check 'PORT supplied by a ConfigMap' reject '.envFrom = [{configMapRef:{name:"config"}}]'
check 'PORT supplied by a field reference' reject '.env = [{name:"PORT", valueFrom:{fieldRef:{fieldPath:"metadata.name"}}}]'
check 'invalid PORT' reject '.env = [{name:"PORT",value:"65536"}]'
check 'default probe timeout' reject 'del(.readinessProbe.timeoutSeconds)'
check 'probe timeout below minimum' reject '.readinessProbe.timeoutSeconds = 24'
check 'external probe host' reject '.readinessProbe.httpGet.host = "other"'
check 'wrong health endpoint' reject '.readinessProbe.httpGet.path = "/supported"'
