#!/usr/bin/env bash
# Builds the example apps as static sites under <site>/<name>/, each served at
# /PageLens/<name>/ on GitHub Pages and loading the one shared /PageLens/lib.js.
# Used by .github/workflows/deploy.yml; run it locally to test:
#   scripts/build-examples.sh /tmp/site
# Expects dependencies installed in each example (the workflow installs them).
set -euo pipefail
SITE="$(cd "$1" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE=/PageLens
LIB="$BASE/lib.js"

# Points every page's PageLens start tag at the shared lib.js, and drops the copy
# of public/pagelens/ the build took (a symlink to dist/lib.js in development).
# Next.js also keeps the page's markup in its own data (inline in the HTML, and in
# .txt files); the path is replaced there too, or React sees a different page when
# it hydrates, re-renders it, and removes the PageLens widget.
use_shared_lib() {
  local out="$1"
  rm -rf "$out/pagelens"
  find "$out" -type f \( -name '*.html' -o -name '*.txt' \) -print0 |
    xargs -0 sed -i.bak -E "s#($BASE/[a-z-]+)?/pagelens/lib\.js#$LIB#g"
  find "$out" -name '*.bak' -delete
  grep -qF "src=\"$LIB\"" "$out/index.html"
  ! grep -rqF "/pagelens/lib.js" "$out" --include='*.html' --include='*.txt'
}

# Vite apps: base URL set at build time (their routers use it as basename).
for app in dashboard:shadcn-admin storefront:storefront restaurant:restaurant; do
  name="${app%%:*}"; dir="${app#*:}"
  echo "== $name (examples/$dir)"
  (cd "$ROOT/examples/$dir" && npx vite build --base="$BASE/$name/" --outDir "$SITE/$name" --emptyOutDir)
  use_shared_lib "$SITE/$name"
done

# Next.js app: static export with a base path.
echo "== app-landing"
(cd "$ROOT/examples/app-landing" && rm -rf out && BASE_PATH="$BASE/app-landing" NEXT_PUBLIC_BASE_PATH="$BASE/app-landing" npx next build)
rm -rf "$SITE/app-landing" && cp -R "$ROOT/examples/app-landing/out" "$SITE/app-landing"
use_shared_lib "$SITE/app-landing"

# The blog example (examples/blog) is not deployed: its static export has a
# hydration error of its own (also without PageLens), and React's re-render then
# removes the PageLens widget.

echo "Built: $(ls "$SITE" | tr '\n' ' ')"
