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
# No baked-in HEALTHCHECK: the periodic check process keeps file pages
# active and inflates docker stats. Opt in via compose or --health-cmd
# against GET /healthz instead.
ENTRYPOINT ["/dksend"]
