# Runs Playwright end-to-end tests against a locally-built server binary.
# Build and run from the repo root:
#   docker build -f tests/e2e/Dockerfile -t dksend-e2e .
#   docker run --rm dksend-e2e

# ── Stage 1: build the server binary ────────────────────────────────────────
FROM rust:1.96-alpine AS builder

RUN apk add --no-cache musl-dev build-base

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static
COPY migrations ./migrations

RUN cargo build

# ── Stage 2: run Playwright tests ───────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Copy server binary and runtime assets
COPY --from=builder /app/target/debug/dksend ./dksend
COPY --from=builder /app/static ./static
COPY --from=builder /app/migrations ./migrations

# Copy e2e test suite
COPY tests/e2e ./tests/e2e

WORKDIR /app/tests/e2e
RUN npm ci

ENV SERVER_BIN=/app/dksend
ENV DATA_DIR=/tmp/dksend-test-data
ENV CI=true

CMD ["npx", "playwright", "test"]
