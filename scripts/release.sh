#!/usr/bin/env bash
# Releases a version: commits the version bump, waits for CI on that commit, tags it, and
# publishes the GitHub release once the tag's workflow has published the package to npm.
#
# Usage: scripts/release.sh <version>      e.g. 0.2.0 or 0.2.0-rc.1
set -euo pipefail

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]]; then
  echo "Usage: scripts/release.sh <version>   (X.Y.Z, optionally -alpha.N, -beta.N or -rc.N)" >&2
  exit 1
fi
tag="v$version"

cd "$(dirname "$0")/.."
git fetch --quiet origin main --tags
if [ "$(git branch --show-current)" != main ] || [ -n "$(git status --porcelain)" ]; then
  echo "Release from a clean main branch." >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main is not in sync with origin/main." >&2
  exit 1
fi
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists." >&2
  exit 1
fi

# Waits for a workflow run on a commit to appear, then for it to finish successfully.
wait_for() { # <workflow file> <commit>
  local run=""
  until [ -n "$run" ]; do
    sleep 3
    run="$(gh run list --workflow "$1" --commit "$2" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  done
  gh run watch "$run" --exit-status --interval 10 >/dev/null
}

for manifest in packages/cli/package.json plugins/claude-code/.claude-plugin/plugin.json; do
  VERSION="$version" bun -e '
    const path = process.argv[1];
    const manifest = await Bun.file(path).json();
    manifest.version = process.env.VERSION;
    await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$manifest"
done
bun run format >/dev/null

if [ -n "$(git status --porcelain)" ]; then
  git commit --quiet --all --message "chore: release $tag"
  git push --quiet origin main
fi
commit="$(git rev-parse HEAD)"

echo "Waiting for CI on ${commit:0:7}..."
wait_for ci.yml "$commit"

git tag "$tag"
git push --quiet origin "$tag"
prerelease=()
[[ "$version" == *-* ]] && prerelease=(--prerelease)
gh release create "$tag" --draft --verify-tag --generate-notes ${prerelease[@]+"${prerelease[@]}"} >/dev/null

echo "Waiting for $tag to be published to npm..."
wait_for release.yml "$commit"
gh release edit "$tag" --draft=false >/dev/null
echo "Released $tag."
