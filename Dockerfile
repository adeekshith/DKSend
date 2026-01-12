# syntax=docker/dockerfile:1
FROM rust:alpine AS builder

RUN apk add --no-cache musl-dev build-base ca-certificates

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release

COPY . .
RUN cargo build --release \
    && cp /app/target/release/dksend /dksend \
    && mkdir -p /data

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /dksend /dksend
COPY --from=builder /data /data

ENV DATA_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/dksend"]
