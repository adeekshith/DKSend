# syntax=docker/dockerfile:1
FROM rust:alpine AS builder

RUN apk add --no-cache musl-dev build-base ca-certificates

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static
COPY migrations ./migrations
RUN cargo build --release \
    && cp /app/target/release/dksend /dksend \
    && mkdir -p /data

FROM alpine:latest
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /dksend /dksend
COPY --from=builder /data /data
COPY --from=builder /app/static /app/static

ENV DATA_DIR=/data
EXPOSE 3000
# BusyBox wget ships with Alpine; override the URL if you change PORT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/dksend"]
