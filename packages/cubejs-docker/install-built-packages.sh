#!/bin/sh
set -eu

PACKAGES_DIR="${1:-}"
REQUIRED="${2:-false}"

if [ -z "$PACKAGES_DIR" ] || [ ! -d "$PACKAGES_DIR" ]; then
  if [ "$REQUIRED" = "true" ]; then
    echo "ERROR: Built packages are required but directory is missing: ${PACKAGES_DIR}"
    exit 1
  fi
  echo "No built packages directory, skipping"
  exit 0
fi

if ! ls "$PACKAGES_DIR"/*.tgz >/dev/null 2>&1; then
  if [ "$REQUIRED" = "true" ]; then
    echo "ERROR: Built packages are required but no tarballs found in ${PACKAGES_DIR}"
    exit 1
  fi
  echo "No built package tarballs found in ${PACKAGES_DIR}, skipping"
  exit 0
fi

installed=0
echo "Overlaying built packages from ${PACKAGES_DIR}..."
for pkg_tgz in "$PACKAGES_DIR"/*.tgz; do
  [ -f "$pkg_tgz" ] || continue
  temp_dir=$(mktemp -d)
  tar xzf "$pkg_tgz" -C "$temp_dir"
  pkg_name=$(node -p "require('${temp_dir}/package/package.json').name")
  dest="node_modules/${pkg_name}"
  echo "Installing ${pkg_name} -> ${dest}"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$temp_dir/package" "$dest"
  rm -rf "$temp_dir"
  installed=$((installed + 1))
done

if [ "$REQUIRED" = "true" ] && [ "$installed" -eq 0 ]; then
  echo "ERROR: No built packages were installed"
  exit 1
fi

# Verify key runtime packages were built and installed from source.
for required_pkg in \
  "node_modules/cubejs-cli/dist/src/index.js" \
  "node_modules/@cubejs-backend/server/index.js" \
  "node_modules/@cubejs-backend/dm-driver/dist/src/index.js"
do
  if [ ! -f "$required_pkg" ]; then
    echo "ERROR: Missing required built artifact: ${required_pkg}"
    exit 1
  fi
done

echo "Installed ${installed} built packages successfully"
