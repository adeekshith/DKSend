# EkSend

EkSend is a temporary file sharing server with a clean CLI + web UX.

## Quick start

```bash
cargo run
```

Server listens on `http://localhost:3000`.

## Upload (CLI)

```bash
curl --upload-file ./hello.txt http://localhost:3000
curl --upload-file ./hello.txt "http://localhost:3000/?expires=1h"
curl --upload-file ./hello.txt "http://localhost:3000/?name=hello.txt"
```

Responses are JSON.

## Download

- Web page: `GET /{code}/{filename}`
- Raw file: `GET /raw/{code}/{filename}`

## Configuration

Environment variables:

- `DATA_DIR` (default: `./data`)
- `MAX_FILE_SIZE` in bytes (default: 209715200)
- `DEFAULT_EXPIRY` (default: `24h`)
- `MAX_EXPIRY` (default: `7d`)

Durations use `30m`, `1h`, `2d`.

## Docker / Podman

Build:

```bash
docker build -t eksend .
```

Run:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/data:/data eksend
```

Podman:

```bash
podman build -t eksend .
podman run --rm -p 3000:3000 -v $(pwd)/data:/data eksend
```

## Behavior notes

- Expiry is clamped to a minimum of 5 minutes and a maximum of 7 days.
- Filenames in URLs are cosmetic; mismatches redirect to the canonical name.
- Expired uploads return HTTP 410.

## Database

SQLite with migrations in `migrations/`. Metadata is stored in `uploads.db` under `DATA_DIR`.
