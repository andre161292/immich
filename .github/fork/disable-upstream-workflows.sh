#!/usr/bin/env bash
# Disables every workflow that does not belong to the fork (fork-*.yml).
# Upstream workflows rely on self-hosted runners and secrets that only exist in immich-app/immich,
# and some of them (docker, sdk, cli, fdroid, docs) would run when the fork publishes a release.
# The enabled/disabled state lives on GitHub, so nothing in the upstream files has to change.
#
# Requires GH_TOKEN with `actions: write` and GITHUB_REPOSITORY (both set in GitHub Actions).
set -euo pipefail

repo="${GITHUB_REPOSITORY:?}"

gh api --paginate "repos/${repo}/actions/workflows" --jq '.workflows[] | [.id, .path, .state] | @tsv' |
  while IFS=$'\t' read -r id path state; do
    name="$(basename "$path")"
    if [[ "$name" == fork-* || "$path" != .github/workflows/* ]]; then
      continue
    fi
    if [[ "$state" == "active" ]]; then
      echo "Disabling ${path}"
      gh api --method PUT "repos/${repo}/actions/workflows/${id}/disable"
    fi
  done
