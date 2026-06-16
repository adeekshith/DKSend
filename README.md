# DKSend

DKSend is a small, self-hostable temporary file sharing server with a clean CLI + web UX. Upload a file, get a short link, and it expires on its own.

- Upload via `curl` or the web UI (drag & drop, paste a screenshot, multiple files, live progress bar)
- Short share codes, QR codes, SHA-256 integrity hashes, per-upload delete links
- Optional upload token, total storage cap, per-IP rate limits, access log, admin page
- Single static binary, SQLite storage, ~4 MB non-root Docker image, no external services

## Quick start

Docker:

```bash
docker run --rm -p 3000:3000 -v dksend-data:/data ghcr.io/adeekshith/dksend:latest
```

From source:

```bash
cargo run
```

Server listens on `http://localhost:3000`. For a production setup see [Docker Compose](#docker-compose) and [Configuration](#configuration).

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
  "raw_download_url": "...",
  "delete_token": "...",
  "delete_url": "..."
}
```

Plain responses add a third `delete:<url>` line after the share URL and `sha256:` lines.

## Authentication

Uploads are open to anyone by default. Set `UPLOAD_TOKEN` to require a shared token for uploads — recommended for instances reachable from the internet. Both header spellings work:

```bash
UPLOAD_TOKEN=change-me cargo run
curl -H "X-Upload-Token: change-me" --upload-file ./hello.txt http://localhost:3000
curl -H "Authorization: Bearer change-me" --upload-file ./hello.txt http://localhost:3000
```

Prefer `X-Upload-Token` when DKSend sits behind a reverse proxy: proxy auth middleware (basic auth, Authelia, oauth2-proxy, ...) often intercepts the `Authorization` header and rejects the request before it reaches DKSend. The web UI uses `X-Upload-Token` for this reason.

The web UI shows an "Upload token" field when a token is configured. Downloads stay public; anyone with a share link can fetch the file.

## Share text

The web UI has a **File / Text** toggle. Switch to **Text**, paste or type into the box, and share the link — the snippet is stored as a `text/plain` upload and rides the same expiry, delete, and size limits as a file. Recipients see it rendered inline on the download page (see below), with a copy button.

## Download

- Web page: `GET /{code}/{filename}` — shows filename, size, expiry, a QR code of the share link (handy for phone-to-laptop transfers), and the SHA-256 hash with a copy button so recipients can verify with `shasum -a 256 file`. The upload result panel shows the same QR code.
- Raw file: `GET /raw/{code}/{filename}` — responses carry the exact `Content-Length`, so browsers and `curl` show real download progress.

Text uploads (anything that is valid UTF-8 and under 256 KB — pasted notes, configs, `.log`/`.csv` files) render inline on the download page with a copy button, so recipients can read them without downloading. Larger or binary files keep the download-only view.

## Delete

Every upload gets its own secret delete token, returned as `delete_token`/`delete_url` and shown in the web UI. Either:

- Open the `delete_url` in a browser and confirm on the page, or
- `curl -X DELETE "http://localhost:3000/{code}?token=<delete_token>"`

Deleting removes the file and its metadata immediately. A second delete returns 404. Uploads created before this feature have no delete token and can only expire.

## Admin

When `UPLOAD_TOKEN` is set, `GET /admin` shows a token form; entering the token lists all active uploads (code, filename, size, upload time, expiry) with a per-file Delete button. Without `UPLOAD_TOKEN` the admin endpoints return 404.

Note that `UPLOAD_TOKEN` is therefore a full admin credential: anyone holding it can list and delete every upload, including ones created before delete tokens existed. Token attempts are slowed by the lookup rate limit, so a busy admin session can hit HTTP 429 — raise `RATE_LIMIT_LOOKUPS_PER_MIN` if that bites.

## Configuration

All configuration is via environment variables; every one is optional.

| Variable | Default | Description |
|---|---|---|
| `UPLOAD_TOKEN` | unset (open uploads) | Require `Authorization: Bearer <token>` for uploads; also enables `/admin`. Recommended for internet-facing instances. |
| `BASE_URL` | unset | Public URL used in share links, e.g. `https://files.example.com`. When unset, URLs are derived from the `Host` header. |
| `MAX_FILE_SIZE` | `209715200` (200 MB) | Per-upload size limit in bytes. |
| `MAX_TOTAL_STORAGE` | unset (unlimited) | Cap on total stored bytes across all uploads; uploads beyond it get HTTP 507. |
| `DEFAULT_EXPIRY` | `1d` | Lifetime applied when the uploader doesn't pick one. |
| `MAX_EXPIRY` | `7d` | Longest allowed lifetime. |
| `RATE_LIMIT_UPLOADS_PER_MIN` | `20` (`0` disables) | Per-IP upload requests per minute. |
| `RATE_LIMIT_LOOKUPS_PER_MIN` | `60` (`0` disables) | Per-IP download/page requests per minute (slows share-code guessing). |
| `DATA_DIR` | `./data` (`/data` in Docker) | Storage path for the database and files. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind address and listen port. |
| `CLEANUP_INTERVAL` | `1h` (minimum `1m`) | How often expired uploads are purged. |
| `ACCESS_LOG` | on (`0`/`false`/`off` disables) | Per-request log lines on stderr. |
| `BRAND_TITLE` | `Send Files` | HTML title and page heading. |
| `BRAND_DESCRIPTION` | empty | Optional tagline below the heading. |

Durations use `30m`, `1h`, `2d`.

The web UI follows this configuration: the client-side size check uses `MAX_FILE_SIZE`, and the expiry dropdown is rendered from `DEFAULT_EXPIRY`/`MAX_EXPIRY`.

## Web UI

- Uploads show a live progress bar with transferred/total bytes.
- Select or drop multiple files: they upload one after another, each getting its own result card with links and QR code. The filename override applies only when a single file is selected.
- Paste a file or screenshot (Ctrl/Cmd+V) anywhere on the upload page to select it; pasted files get a generated name like `pasted-2026-06-10-181203.png`. Pasting text into the token or filename fields works as usual.

## Access log

One line per request is written to stderr (where `docker logs` collects it):

```
2026-06-10T18:21:03Z event=upload ip=1.2.3.4 status=201 code=ab3x9 size=11 file=report.pdf
2026-06-10T18:22:41Z event=page ip=5.6.7.8 status=200 code=ab3x9
2026-06-10T18:22:44Z event=download ip=5.6.7.8 status=200 code=ab3x9
2026-06-10T18:25:02Z event=delete ip=1.2.3.4 status=200 code=ab3x9 outcome=deleted
```

Events: `upload` (201/401/429/507), `page` and `download` (200/404/410/429 — 404s are what share-code guessing looks like), `delete` (with `outcome=`). Lines are grep-friendly: `grep 'status=404'`, `grep 'code=ab3x9'`. Set `ACCESS_LOG=0` to disable.

## Health check

`GET /healthz` returns `{"status":"ok"}` with HTTP 200 when the server and its database are reachable (503 otherwise). The Docker image deliberately ships no built-in `HEALTHCHECK` — the periodic check process keeps page-cache pages active, which inflates `docker stats` by a few MB. Opt in by uncommenting the `healthcheck` block in [docker-compose.yml](docker-compose.yml) or pointing your monitoring at `/healthz`. The server also shuts down cleanly on SIGTERM/SIGINT, finishing in-flight requests, so `docker stop` is fast.

## Docker / Podman

The container runs as an unprivileged user (uid 1000). When bind-mounting a data directory, make sure uid 1000 can write to it:

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

**Upgrading from an older (root) image:** an existing data directory is likely root-owned, so the new image refuses to start — `docker logs` shows `DKSend error: data directory /data/files is not writable by the server process` with the fix spelled out. Run the one-time `chown` above (or temporarily run with `--user 0:0` while migrating).

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

All common settings are documented inline as comments — uncomment what you need. Remember to pre-create the data directory writable by uid 1000 (see above).

## Deploy from GHCR

The GitHub Actions workflow publishes images (currently linux/amd64) to:

`ghcr.io/adeekshith/dksend`

Pull and run:

```bash
docker pull ghcr.io/adeekshith/dksend:latest
docker run --rm -p 3000:3000 -v $(pwd)/data:/data ghcr.io/adeekshith/dksend:latest
```

Example with the settings most internet-facing instances want:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/data:/data \
  -e BASE_URL=https://files.example.com \
  -e UPLOAD_TOKEN=change-me \
  -e MAX_FILE_SIZE=209715200 \
  -e MAX_TOTAL_STORAGE=10737418240 \
  -e DEFAULT_EXPIRY=1d \
  -e MAX_EXPIRY=7d \
  -e BRAND_TITLE="My Share" \
  -e BRAND_DESCRIPTION="Fast, friendly file drops." \
  ghcr.io/adeekshith/dksend:latest
```

`DATA_DIR` defaults to `/data` inside the image, so only the volume mount is needed. See [Configuration](#configuration) for the full list.

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

- Expiry is clamped to a minimum of 5 minutes and a maximum of `MAX_EXPIRY` (default 7 days).
- Filenames in URLs are cosmetic; mismatches redirect to the canonical name.
- Expired uploads return HTTP 410.

## Limits

- When `MAX_TOTAL_STORAGE` is set, uploads that would exceed it are rejected with HTTP 507. Usage counts all uploads still on disk, including expired ones awaiting cleanup. Concurrent uploads are checked individually, so the cap can briefly overshoot by up to one `MAX_FILE_SIZE` per in-flight upload.
- Rate-limited requests get HTTP 429 with a `Retry-After` header. Limits are keyed by client IP, using the first `X-Forwarded-For` entry when present (set by your reverse proxy) and the socket address otherwise. Lookup limits apply to download pages and raw downloads to slow share-code guessing.

## Database

SQLite with migrations in `migrations/`. Metadata is stored in `uploads.db` under `DATA_DIR`.

## Vendored assets

- `static/qr.js` — [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) v2.0.4 by Kazuhiko Arase, MIT license (header retained in the file).
