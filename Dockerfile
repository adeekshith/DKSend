# syntax=docker/dockerfile:1
FROM rust:1.85-slim AS builder

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
        amd64) echo x86_64-unknown-linux-musl > /tmp/target ;; \
        arm64) echo aarch64-unknown-linux-musl > /tmp/target ;; \
        *) echo "unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac \
    && rustup target add "$(cat /tmp/target)"

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release --target "$(cat /tmp/target)"

COPY . .
RUN cargo build --release --target "$(cat /tmp/target)" \
    && cp "/app/target/$(cat /tmp/target)/release/eksend" /eksend \
    && mkdir -p /data

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /eksend /eksend
COPY --from=builder /data /data

ENV DATA_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/eksend"]
