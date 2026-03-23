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

Responses are JSON (pretty-printed) by default. Use `Accept: text/plain` or `output=plain` for a bare share URL.

## Download

- Web page: `GET /{code}/{filename}`
- Raw file: `GET /raw/{code}/{filename}`

## Configuration

Environment variables:

- `DATA_DIR` (default: `./data`) - storage path for database + files
- `MAX_FILE_SIZE` in bytes (default: 209715200)
- `DEFAULT_EXPIRY` (default: `1d`)
- `MAX_EXPIRY` (default: `7d`)
- `BRAND_TITLE` (default: `Send Files`) - HTML title and header text
- `BRAND_DESCRIPTION` (default: empty) - optional tagline shown below the heading

Durations use `30m`, `1h`, `2d`.

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

## Database

SQLite with migrations in `migrations/`. Metadata is stored in `uploads.db` under `DATA_DIR`.
