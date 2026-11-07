#!/usr/bin/env sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22 ou plus récent est requis.' >&2
  exit 1
fi
exec node server.mjs --open
