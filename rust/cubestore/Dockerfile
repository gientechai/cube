ARG USE_PREBUILT_BINARY=false
ARG WITH_AVX2=1

FROM cubejs/rust-builder:bookworm-llvm-18 AS builder

WORKDIR /build/cubestore

COPY cube/cubeshared /build/cube/cubeshared

COPY cubestore/rust-toolchain.toml .
COPY cubestore/Cargo.toml .
COPY cubestore/Cargo.lock .
COPY cubestore/cuberockstore cuberockstore
COPY cubestore/cubehll cubehll
COPY cubestore/cubezetasketch cubezetasketch
COPY cubestore/cubedatasketches cubedatasketches
COPY cubestore/cuberpc cuberpc
COPY cubestore/cubestore-sql-tests cubestore-sql-tests
COPY cubestore/cubestore/benches cubestore/benches
COPY cubestore/cubestore/Cargo.toml cubestore/Cargo.toml
RUN mkdir -p cubestore/src/bin && \
    echo "fn main() {print!(\"Dummy main\");} // dummy file" > cubestore/src/bin/cubestored.rs

# Only build if not using prebuilt binary
RUN if [ "$USE_PREBUILT_BINARY" != "true" ]; then \
      [ "$WITH_AVX2" -eq "1" ] && export RUSTFLAGS="-C target-feature=+avx2"; \
      cargo build --release -p cubestore; \
    fi

# Cube Store get version from his own package
COPY cubestore/package.json package.json
COPY cubestore/cubestore cubestore
RUN if [ "$USE_PREBUILT_BINARY" != "true" ]; then \
      [ "$WITH_AVX2" -eq "1" ] && export RUSTFLAGS="-C target-feature=+avx2"; \
      cargo build --release -p cubestore; \
    fi

FROM debian:bookworm-slim

WORKDIR /cube

RUN set -ex; \
    apt-get update; \
    apt-get install -y libssl3 ca-certificates

# Copy prebuilt binary if available, otherwise copy built binary
COPY --from=builder /build/cubestore/prebuilt-bin/ ./prebuilt-bin/ 2>/dev/null || true
COPY --from=builder /build/cubestore/target/release/cubestored ./cubestored-built 2>/dev/null || true
RUN if [ -f "./prebuilt-bin/cubestored" ]; then \
      cp ./prebuilt-bin/cubestored ./cubestored; \
    elif [ -f "./cubestored-built" ]; then \
      cp ./cubestored-built ./cubestored; \
    else \
      echo "Error: No cubestored binary found"; exit 1; \
    fi && \
    chmod +x ./cubestored && \
    rm -rf ./prebuilt-bin ./cubestored-built

EXPOSE 3306

ENV RUST_BACKTRACE=true

CMD ["./cubestored"]
