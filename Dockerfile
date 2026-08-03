# syntax=docker/dockerfile:1
FROM rust:1.97-alpine AS builder

RUN apk add --no-cache musl-dev build-base ca-certificates

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static
COPY migrations ./migrations
RUN cargo build --release \
    && cp /app/target/release/dksend /dksend

FROM alpine:latest
# uid 1000 matches the default first user on most hosts, so a bind-mounted
# ./data created by that user works without a chown
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 1000 dksend
WORKDIR /app
COPY --from=builder /dksend /dksend
COPY --from=builder /app/static /app/static
RUN mkdir -p /data && chown dksend:dksend /data

ENV DATA_DIR=/data
EXPOSE 3000
# No baked-in HEALTHCHECK: the periodic check process keeps file pages
# active and inflates docker stats. Opt in via compose or --health-cmd
# against GET /healthz instead.
USER dksend
ENTRYPOINT ["/dksend"]
