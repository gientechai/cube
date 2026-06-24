FROM node:22.22.0-bookworm-slim AS builder

WORKDIR /cube
COPY . .

ARG NPM_PACKAGES_VERSION

RUN yarn policies set-version v1.22.22
# Yarn v1 uses aggressive timeouts with summing time spending on fs, https://github.com/yarnpkg/yarn/issues/4890
RUN yarn config set network-timeout 120000 -g

# Required for node-oracledb to buld on ARM64
RUN apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    # libpython3-dev is needed to trigger post-installer to download native with python
    && apt-get install -y python3 python3.11 libpython3.11-dev gcc g++ make cmake ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# All @cubejs-backend/* and cubejs-cli packages are built from source in CI and published
# as tarballs. Stage them before install so we can overlay npm registry copies later.
RUN if [ -d "npm-packages" ] && [ "$(ls -A npm-packages/*.tgz 2>/dev/null)" ]; then \
      cp -r npm-packages /tmp/built-packages; \
    elif [ -n "$NPM_PACKAGES_VERSION" ] && [ "$NPM_PACKAGES_VERSION" != "noop" ]; then \
      echo "Downloading built packages from GitHub Releases..." && \
      curl -fL -o built-packages.tar.gz "https://github.com/gientechai/cube/releases/download/${NPM_PACKAGES_VERSION}/npm-packages-${NPM_PACKAGES_VERSION}.tar.gz" && \
      mkdir -p /tmp/built-packages && \
      tar xzf built-packages.tar.gz -C /tmp/built-packages && \
      rm -f built-packages.tar.gz; \
    fi

# yarn install only pulls third-party transitive dependencies. All Cube packages are
# replaced with CI-built tarballs in the next step (custom forks must not use npm code).
# dm-driver is not on public npm — drop it here so yarn install succeeds in Docker;
# it is restored from built tarballs below. (In the monorepo, yarn workspaces still
# link packages/cubejs-dm-driver via package.json.)
RUN node -e "const p=require('./package.json'); delete p.dependencies['@cubejs-backend/dm-driver']; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')" \
    && yarn install --prod \
    && rm -rf /cube/node_modules/duckdb/src \
    && yarn cache clean

RUN set -eu && \
    PACKAGES_DIR=/tmp/built-packages && \
    if [ ! -d "${PACKAGES_DIR}" ] || ! ls "${PACKAGES_DIR}"/*.tgz >/dev/null 2>&1; then \
      echo "ERROR: Built packages are required but not found in ${PACKAGES_DIR}"; \
      exit 1; \
    fi && \
    installed=0 && \
    echo "Overlaying built packages from ${PACKAGES_DIR}..." && \
    for pkg_tgz in "${PACKAGES_DIR}"/*.tgz; do \
      [ -f "${pkg_tgz}" ] || continue; \
      temp_dir=$(mktemp -d); \
      tar xzf "${pkg_tgz}" -C "${temp_dir}"; \
      pkg_name=$(node -p "require('${temp_dir}/package/package.json').name"); \
      dest="node_modules/${pkg_name}"; \
      echo "Installing ${pkg_name} -> ${dest}"; \
      rm -rf "${dest}"; \
      mkdir -p "$(dirname "${dest}")"; \
      mv "${temp_dir}/package" "${dest}"; \
      rm -rf "${temp_dir}"; \
      installed=$((installed + 1)); \
    done && \
    test "${installed}" -gt 0 && \
    test -f node_modules/cubejs-cli/dist/src/index.js && \
    test -f node_modules/@cubejs-backend/server/index.js && \
    test -f node_modules/@cubejs-backend/dm-driver/dist/src/index.js && \
    chmod +x node_modules/cubejs-cli/dist/src/index.js && \
    echo "Installed ${installed} built packages successfully" && \
    rm -rf /tmp/built-packages /cube/npm-packages

# Always install native from the same release tag as the JS tarballs.
# Overlaying @cubejs-backend/native removes the index.node that yarn postinstall
# may have fetched from upstream; this step must succeed or queries fail at runtime.
RUN set -eu && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      NATIVE_ARCH="x64"; \
    elif [ "$ARCH" = "aarch64" ]; then \
      NATIVE_ARCH="arm64"; \
    else \
      echo "Unsupported architecture: $ARCH"; \
      exit 1; \
    fi && \
    if [ -z "${NPM_PACKAGES_VERSION:-}" ] || [ "$NPM_PACKAGES_VERSION" = "noop" ]; then \
      echo "ERROR: NPM_PACKAGES_VERSION is required to install a matching native binary"; \
      exit 1; \
    fi && \
    echo "Installing native-linux-${NATIVE_ARCH}-glibc-fallback from release ${NPM_PACKAGES_VERSION}..." && \
    curl -fL -o native.tar.gz "https://github.com/gientechai/cube/releases/download/${NPM_PACKAGES_VERSION}/native-linux-${NATIVE_ARCH}-glibc-fallback.tar.gz" && \
    mkdir -p native && \
    tar xzf native.tar.gz -C native && \
    rm -f native.tar.gz && \
    test -f native/native/index.node && \
    mkdir -p /cube/node_modules/@cubejs-backend/native/native && \
    cp native/native/index.node /cube/node_modules/@cubejs-backend/native/native/index.node && \
    grep -aq "JsBuffer with columnar" /cube/node_modules/@cubejs-backend/native/native/index.node && \
    echo "Native binary installed and verified for ${NATIVE_ARCH}"

FROM node:22.22.0-bookworm-slim

ARG IMAGE_VERSION=unknown

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends libssl3 python3.11 libpython3.11-dev \
    && rm -rf /var/lib/apt/lists/*

RUN yarn policies set-version v1.22.22

ENV NODE_ENV=production
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

WORKDIR /cube

COPY --from=builder /cube .

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH=/cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s /cube/node_modules/.bin/cubejs /usr/local/bin/cubejs
RUN ln -s /cube/node_modules/.bin/cubestore-dev /usr/local/bin/cubestore-dev
RUN cubejs --version

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]
