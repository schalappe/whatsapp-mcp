#!/usr/bin/env sh
# Install a pinned Betterleaks release after checking it against the release's checksums.txt.
# Used by CI (security.yml) and by anyone setting up the pre-commit hook locally.
# Usage: scripts/install-betterleaks.sh <version, without the v> <install dir>
set -eu

version=$1
dir=$2

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="betterleaks_${version}_${os}_${arch}.tar.gz"
base="https://github.com/betterleaks/betterleaks/releases/download/v${version}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -sSfL -o "$tmp/$asset" "$base/$asset"
curl -sSfL -o "$tmp/checksums.txt" "$base/checksums.txt"

expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $asset: expected '${expected}', got '${actual}'" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp" betterleaks
mkdir -p "$dir"
install -m 0755 "$tmp/betterleaks" "$dir/betterleaks"
"$dir/betterleaks" version
