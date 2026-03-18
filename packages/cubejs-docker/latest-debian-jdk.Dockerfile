# syntax=docker/dockerfile-upstream:master-experimental
FROM node:22.20.0-bookworm-slim AS builder

WORKDIR /cube
COPY . .

# Add build-arg for npm packages version
ARG NPM_PACKAGES_VERSION

RUN yarn policies set-version v1.22.22
# Yarn v1 uses aggressive timeouts with summing time spending on fs, https://github.com/yarnpkg/yarn/issues/4890
RUN yarn config set network-timeout 120000 -g

# Required for node-oracledb to buld on ARM64
RUN apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    # libpython3-dev is needed to trigger post-installer to download native with python
    && apt-get install -y python3 python3.11 libpython3.11-dev gcc g++ make cmake openjdk-17-jdk-headless curl \
    && rm -rf /var/lib/apt/lists/*

# Install npm packages from local tarballs or download from GitHub Releases
# First, save npm-packages to a temp location for later re-installation
RUN if [ -d "npm-packages" ] && [ "$(ls -A npm-packages/*.tgz 2>/dev/null)" ]; then \
      cp -r npm-packages /tmp/npm-packages-backup; \
    elif [ -n "$NPM_PACKAGES_VERSION" ] && [ "$NPM_PACKAGES_VERSION" != "noop" ]; then \
      echo "Downloading npm packages from GitHub Releases..." && \
      curl -fL -o npm-packages.tar.gz "https://github.com/gientechai/cube/releases/download/v${NPM_PACKAGES_VERSION}/npm-packages-${NPM_PACKAGES_VERSION}.tar.gz" && \
      mkdir -p /tmp/npm-packages-backup && \
      tar xzf npm-packages.tar.gz -C /tmp/npm-packages-backup && \
      rm -f npm-packages.tar.gz; \
    fi

# We are copying root yarn.lock file to the context folder during the Publish GH
# action. So, a process will use the root lock file here.
RUN yarn install --prod \
    # Remove unnecessary files to reduce image size
    && rm -rf /cube/node_modules/duckdb/src \
    && find /cube/node_modules -name "*.md" -type f -delete \
    && find /cube/node_modules -name "test" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /cube/node_modules -name "*.test.js" -o -name "*.test.ts" | xargs rm -f 2>/dev/null || true \
    && find /cube/node_modules -name "*.map" -type f -delete 2>/dev/null || true \
    && yarn cache clean

# Re-install our custom packages from npm-packages-backup to override npm registry versions
RUN if [ -d "/tmp/npm-packages-backup" ]; then \
      echo "Re-installing custom packages from GitHub Releases..." && \
      for pkg in /tmp/npm-packages-backup/*.tgz; do \
        temp_dir=$(mktemp -d) && \
        tar xzf "$pkg" -C "$temp_dir" && \
        pkg_name=$(cat "$temp_dir"/package/package.json | grep -m1 '"name"' | cut -d'"' -f4) && \
        if [ -n "$pkg_name" ]; then \
          rm -rf "/cube/node_modules/$pkg_name" && \
          mv "$temp_dir/package" "/cube/node_modules/$pkg_name"; \
        fi && \
        rm -rf "$temp_dir"; \
      done; \
      rm -rf /tmp/npm-packages-backup; \
    fi

# Fix file permissions for executables and clean up npm-packages directory
RUN chmod +x /cube/node_modules/cubejs-cli/dist/src/index.js \
    && chmod +x /cube/node_modules/.bin/cubejs \
    && rm -rf /cube/npm-packages

# Copy native binaries if available
RUN if [ -d "native" ] && [ -f "native/native/index.node" ]; then \
      mkdir -p /cube/node_modules/@cubejs-backend/native/native && \
      cp native/native/index.node /cube/node_modules/@cubejs-backend/native/native/ && \
      echo "Native binaries copied successfully"; \
    else \
      echo "No native binaries found in native/native/"; \
    fi

FROM node:22.20.0-bookworm-slim

ARG IMAGE_VERSION=unknown

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

RUN groupadd cube && useradd -ms /bin/bash -g cube cube \
    && DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends libssl3 openjdk-17-jre-headless python3.11 libpython3.11-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir cube \
    && chown -R cube:cube /tmp /cube /usr

USER cube
WORKDIR /cube

RUN yarn policies set-version v1.22.22

ENV NODE_ENV production

COPY --chown=cube:cube --from=builder /cube .

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH /cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
RUN ln -s /cube/node_modules/.bin/cubejs /usr/local/bin/cubejs
RUN ln -s /cube/node_modules/.bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]
