# DKSend

DKSend is a temporary file sharing server with a clean CLI + web UX.

## Quick start

```bash
cargo run
```

Server listens on `http://localhost:3000`.

## Upload (CLI)

```bash
curl --upload-file ./hello.txt http://localhost:3000
curl --upload-file ./hello.txt http://localhost:3000/hello.txt
curl --upload-file ./hello.txt "http://localhost:3000/?expires=1h"
curl --upload-file ./hello.txt "http://localhost:3000/?name=hello.txt"
curl -H "Accept: text/plain" --upload-file ./hello.txt http://localhost:3000/hello.txt
curl --upload-file ./hello.txt "http://localhost:3000/hello.txt?output=plain"
```

Responses are JSON (pretty-printed) by default. Use `Accept: text/plain` or `output=plain` for the share URL followed by `sha256:<hex>` on the next line.

The JSON response includes a `sha256` field with the hex-encoded SHA-256 digest of the uploaded bytes:

```json
{
  "success": true,
  "code": "abc12",
  "filename": "hello.txt",
  "size_bytes": 12,
  "sha256": "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  "expires_at": "...",
  "download_page_url": "...",
  "raw_download_url": "..."
}
```

## Authentication

Uploads are open to anyone by default. Set `UPLOAD_TOKEN` to require a shared token for uploads — recommended for instances reachable from the internet:

```bash
UPLOAD_TOKEN=change-me cargo run
curl -H "Authorization: Bearer change-me" --upload-file ./hello.txt http://localhost:3000
```

The web UI shows an "Upload token" field when a token is configured. Downloads stay public; anyone with a share link can fetch the file.

## Download

- Web page: `GET /{code}/{filename}` — shows filename, size, expiry, and the SHA-256 hash with a copy button so recipients can verify with `shasum -a 256 file`.
- Raw file: `GET /raw/{code}/{filename}`

## Configuration

Environment variables:

- `HOST` (default: `0.0.0.0`) - bind address
- `PORT` (default: `3000`) - listen port
- `BASE_URL` (default: unset) - public URL used in share links, e.g. `https://files.example.com`; when unset, URLs are derived from the `Host` header
- `DATA_DIR` (default: `./data`) - storage path for database + files
- `MAX_FILE_SIZE` in bytes (default: 209715200)
- `DEFAULT_EXPIRY` (default: `1d`)
- `MAX_EXPIRY` (default: `7d`)
- `BRAND_TITLE` (default: `Send Files`) - HTML title and header text
- `BRAND_DESCRIPTION` (default: empty) - optional tagline shown below the heading
- `UPLOAD_TOKEN` (default: unset = open uploads) - require `Authorization: Bearer <token>` for uploads
- `MAX_TOTAL_STORAGE` in bytes (default: unset = unlimited) - cap on total stored bytes across all uploads
- `RATE_LIMIT_UPLOADS_PER_MIN` (default: 20, 0 disables) - per-IP upload requests per minute
- `RATE_LIMIT_LOOKUPS_PER_MIN` (default: 60, 0 disables) - per-IP download/page requests per minute
- `CLEANUP_INTERVAL` (default: `1h`, minimum `1m`) - how often expired uploads are purged

Durations use `30m`, `1h`, `2d`.

## Health check

`GET /healthz` returns `{"status":"ok"}` with HTTP 200 when the server and its database are reachable (503 otherwise). The Docker image ships a `HEALTHCHECK` that polls it. The server also shuts down cleanly on SIGTERM/SIGINT, finishing in-flight requests, so `docker stop` is fast.

## Docker / Podman

Build:

```bash
docker build -t dksend .
```

Run:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/data:/data dksend
```

Podman:

```bash
podman build -t dksend .
podman run --rm -p 3000:3000 -v $(pwd)/data:/data dksend
```

## Docker Compose

A production example lives in [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d
```

Uncomment `BASE_URL`, `UPLOAD_TOKEN`, and `MAX_TOTAL_STORAGE` in the file to fit your setup.

## Deploy from GHCR

The GitHub Actions workflow publishes multi-arch images to:

`ghcr.io/adeekshith/dksend`

Pull and run:

```bash
docker pull ghcr.io/adeekshith/dksend:latest
docker run --rm -p 3000:3000 -v $(pwd)/data:/data ghcr.io/adeekshith/dksend:latest
```

Example Docker run with all environment variables:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/data:/data \\
  -e DATA_DIR=/data \\
  -e MAX_FILE_SIZE=209715200 \\
  -e DEFAULT_EXPIRY=24h \\
  -e MAX_EXPIRY=7d \\
  -e BRAND_TITLE="My Share" \\
  -e BRAND_DESCRIPTION="Fast, friendly file drops." \\
  ghcr.io/adeekshith/dksend:latest
```

## Testing

### In Docker (recommended)

Unit tests (Rust + JS):

```bash
docker build -f Dockerfile.test -t dksend-unit-tests .
docker run --rm dksend-unit-tests
```

Playwright end-to-end tests:

```bash
docker build -f tests/e2e/Dockerfile -t dksend-e2e .
docker run --rm dksend-e2e
```

Run both with Docker Compose:

```bash
docker compose -f docker-compose.test.yml up --build
```

### Locally

Rust (backend + integration tests):

```bash
cargo test
```

JavaScript (frontend unit tests):

```bash
node --test static/app.test.js
```

Playwright (end-to-end browser tests):

```bash
cd tests/e2e
npm install
npx playwright install chromium
npx playwright test
```

The Playwright tests automatically start the Rust server via `cargo run`. Set `DATA_DIR` to a temp directory to avoid polluting local data:

```bash
DATA_DIR=/tmp/dksend-test cd tests/e2e && npx playwright test
```

## Behavior notes

- Expiry is clamped to a minimum of 5 minutes and a maximum of 7 days.
- Filenames in URLs are cosmetic; mismatches redirect to the canonical name.
- Expired uploads return HTTP 410.

## Limits

- When `MAX_TOTAL_STORAGE` is set, uploads that would exceed it are rejected with HTTP 507. Usage counts all uploads still on disk, including expired ones awaiting cleanup. Concurrent uploads are checked individually, so the cap can briefly overshoot by up to one `MAX_FILE_SIZE` per in-flight upload.
- Rate-limited requests get HTTP 429 with a `Retry-After` header. Limits are keyed by client IP, using the first `X-Forwarded-For` entry when present (set by your reverse proxy) and the socket address otherwise. Lookup limits apply to download pages and raw downloads to slow share-code guessing.

## Database

SQLite with migrations in `migrations/`. Metadata is stored in `uploads.db` under `DATA_DIR`.
