use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Row, Sqlite};
use std::env;
use std::path::PathBuf;
use std::time::Duration;
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::signal;
use tokio_util::io::ReaderStream;

#[derive(Clone)]
struct AppState {
    pool: Pool<Sqlite>,
    config: AppConfig,
}

#[derive(Clone)]
struct AppConfig {
    data_dir: PathBuf,
    max_file_size: u64,
    default_expiry: Duration,
    min_expiry: Duration,
    max_expiry: Duration,
    code_min_len: usize,
    code_max_len: usize,
    code_retries: usize,
}

#[derive(Debug, Serialize)]
struct UploadResponse {
    success: bool,
    code: String,
    filename: String,
    size_bytes: u64,
    expires_at: String,
    expires_in_seconds: i64,
    download_page_url: String,
    raw_download_url: String,
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    success: bool,
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Debug, serde::Deserialize)]
struct UploadQuery {
    expires: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Clone)]
struct UploadRecord {
    code: String,
    original_filename: String,
    stored_path: String,
    size_bytes: u64,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("EkSend error: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), anyhow::Error> {
    let config = load_config()?;
    let db_path = config.data_dir.join("uploads.db");
    fs::create_dir_all(config.data_dir.join("files")).await?;

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = AppState { pool, config };

    let app = Router::new()
        .route("/", get(upload_page).put(upload_handler))
        .route("/raw/:code", get(raw_download_code))
        .route("/raw/:code/:filename", get(raw_download_named))
        .route("/:code", get(download_page_code))
        .route("/:code/:filename", get(download_page_named))
        .with_state(state.clone());

    let cleanup_state = state.clone();
    tokio::spawn(async move {
        cleanup_loop(cleanup_state).await;
    });

    let listen_addr = "0.0.0.0:3000";
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    println!("EkSend listening on http://{listen_addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}

fn load_config() -> Result<AppConfig, anyhow::Error> {
    let data_dir = env::var("DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    let max_file_size = env::var("MAX_FILE_SIZE")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1024 * 1024 * 200);
    let min_expiry = Duration::from_secs(60 * 5);
    let mut max_expiry = env::var("MAX_EXPIRY")
        .ok()
        .and_then(|value| parse_duration(&value).ok())
        .unwrap_or(Duration::from_secs(60 * 60 * 24 * 7));
    if max_expiry < min_expiry {
        max_expiry = min_expiry;
    }
    let mut default_expiry = env::var("DEFAULT_EXPIRY")
        .ok()
        .and_then(|value| parse_duration(&value).ok())
        .unwrap_or(Duration::from_secs(60 * 60 * 24));
    if default_expiry < min_expiry {
        default_expiry = min_expiry;
    } else if default_expiry > max_expiry {
        default_expiry = max_expiry;
    }

    Ok(AppConfig {
        data_dir: PathBuf::from(data_dir),
        max_file_size,
        default_expiry,
        min_expiry,
        max_expiry,
        code_min_len: 3,
        code_max_len: 8,
        code_retries: 5,
    })
}

async fn upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<UploadQuery>,
    body: Body,
) -> Response {
    let content_length = match headers.get(header::CONTENT_LENGTH) {
        Some(value) => match value.to_str().ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(length) => length,
            None => return json_error(StatusCode::BAD_REQUEST, "CONTENT_LENGTH_INVALID", "Content-Length must be a valid number."),
        },
        None => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "CONTENT_LENGTH_REQUIRED",
                "Content-Length header is required.",
            )
        }
    };

    if content_length > state.config.max_file_size {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "FILE_TOO_LARGE",
            "File exceeds the configured size limit.",
        );
    }

    let filename = params
        .name
        .unwrap_or_else(|| "file".to_string())
        .trim()
        .to_string();
    let filename = if filename.is_empty() {
        "file".to_string()
    } else {
        filename
    };

    let (expiry, warning) = match params.expires.as_deref() {
        Some(value) => match parse_duration(value) {
            Ok(duration) => clamp_expiry(duration, &state.config),
            Err(_) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "EXPIRY_INVALID",
                    "Expiry must be in the format <number><unit>, e.g. 30m, 1h, 2d.",
                )
            }
        },
        None => (state.config.default_expiry, None),
    };

    let code = match generate_code(&state.pool, &state.config).await {
        Ok(code) => code,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CODE_GENERATION_FAILED",
                "Could not allocate a share code. Please retry.",
            )
        }
    };

    let file_path = state.config.data_dir.join("files").join(&code);
    let mut file = match File::create(&file_path).await {
        Ok(file) => file,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "FILE_STORE_FAILED",
                "Could not store the uploaded file.",
            )
        }
    };

    let mut size_written: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = fs::remove_file(&file_path).await;
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "UPLOAD_STREAM_ERROR",
                    "Failed while reading the upload stream.",
                );
            }
        };
        size_written += chunk.len() as u64;
        if size_written > state.config.max_file_size {
            let _ = fs::remove_file(&file_path).await;
            return json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "FILE_TOO_LARGE",
                "File exceeds the configured size limit.",
            );
        }
        if let Err(_) = file.write_all(&chunk).await {
            let _ = fs::remove_file(&file_path).await;
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "FILE_STORE_FAILED",
                "Could not store the uploaded file.",
            );
        }
    }

    let now = Utc::now();
    let expires_at = now + ChronoDuration::from_std(expiry).unwrap_or_else(|_| ChronoDuration::seconds(0));
    let stored_path = file_path.to_string_lossy().to_string();

    if let Err(_) = sqlx::query(
        "INSERT INTO uploads (code, original_filename, stored_path, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&code)
    .bind(&filename)
    .bind(&stored_path)
    .bind(size_written as i64)
    .bind(now.to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .execute(&state.pool)
    .await
    {
        let _ = fs::remove_file(&file_path).await;
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DB_WRITE_FAILED",
            "Could not store upload metadata.",
        );
    }

    let base_url = base_url_from_headers(&headers);
    let encoded_filename = urlencoding::encode(&filename);
    let download_page_url = format!("{base_url}/{code}/{encoded_filename}");
    let raw_download_url = format!("{base_url}/raw/{code}/{encoded_filename}");

    let response = UploadResponse {
        success: true,
        code,
        filename,
        size_bytes: size_written,
        expires_at: expires_at.to_rfc3339(),
        expires_in_seconds: (expires_at - now).num_seconds(),
        download_page_url,
        raw_download_url,
        warning,
    };

    (StatusCode::CREATED, Json(response)).into_response()
}

async fn upload_page() -> Html<String> {
    Html(render_upload_page())
}

async fn download_page_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    download_page(state, headers, code, None).await
}

async fn download_page_named(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((code, filename)): Path<(String, String)>,
) -> Response {
    download_page(state, headers, code, Some(filename)).await
}

async fn download_page(
    state: AppState,
    headers: HeaderMap,
    code: String,
    filename: Option<String>,
) -> Response {
    let record = match fetch_upload(&state.pool, &code).await {
        Ok(Some(record)) => record,
        Ok(None) => return html_error(StatusCode::NOT_FOUND, "This file does not exist."),
        Err(_) => {
            return html_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong while loading this file.",
            )
        }
    };

    if record.expires_at <= Utc::now() {
        return html_error(StatusCode::GONE, "This file does not exist or is no longer available.");
    }

    let canonical_filename = record.original_filename.clone();
    let encoded = urlencoding::encode(&canonical_filename);
    let base_url = base_url_from_headers(&headers);
    let canonical_url = format!("{base_url}/{code}/{encoded}");

    if filename.as_deref() != Some(&canonical_filename) {
        return Redirect::temporary(&canonical_url).into_response();
    }

    Html(render_download_page(&record, &base_url)).into_response()
}

async fn raw_download_code(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Response {
    raw_download(state, code).await
}

async fn raw_download_named(
    State(state): State<AppState>,
    Path((code, _filename)): Path<(String, String)>,
) -> Response {
    raw_download(state, code).await
}

async fn raw_download(state: AppState, code: String) -> Response {
    let record = match fetch_upload(&state.pool, &code).await {
        Ok(Some(record)) => record,
        Ok(None) => return plain_error(StatusCode::NOT_FOUND, "Not found."),
        Err(_) => return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Server error."),
    };

    if record.expires_at <= Utc::now() {
        return plain_error(StatusCode::GONE, "This file does not exist or is no longer available.");
    }

    let file = match File::open(&record.stored_path).await {
        Ok(file) => file,
        Err(_) => return plain_error(StatusCode::NOT_FOUND, "Not found."),
    };

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    let mut response = body.into_response();
    let filename = urlencoding::encode(&record.original_filename);
    let content_disposition = format!("attachment; filename=\"{}\"", filename);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&content_disposition).unwrap_or_else(|_| {
            header::HeaderValue::from_static("attachment")
        }),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=0"),
    );

    response
}

async fn fetch_upload(pool: &Pool<Sqlite>, code: &str) -> Result<Option<UploadRecord>, anyhow::Error> {
    let row = sqlx::query(
        "SELECT code, original_filename, stored_path, size_bytes, created_at, expires_at FROM uploads WHERE code = ?",
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let created_at: String = row.try_get("created_at")?;
    let expires_at: String = row.try_get("expires_at")?;

    let record = UploadRecord {
        code: row.try_get("code")?,
        original_filename: row.try_get("original_filename")?,
        stored_path: row.try_get("stored_path")?,
        size_bytes: row.try_get::<i64, _>("size_bytes")? as u64,
        created_at: parse_datetime(&created_at)?,
        expires_at: parse_datetime(&expires_at)?,
    };

    Ok(Some(record))
}

async fn cleanup_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
    loop {
        interval.tick().await;
        let now = Utc::now().to_rfc3339();
        let rows = match sqlx::query("SELECT code, stored_path FROM uploads WHERE expires_at <= ?")
            .bind(&now)
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(_) => continue,
        };

        for row in rows {
            let stored_path: String = match row.try_get("stored_path") {
                Ok(path) => path,
                Err(_) => continue,
            };
            let _ = fs::remove_file(&stored_path).await;
        }

        let _ = sqlx::query("DELETE FROM uploads WHERE expires_at <= ?")
            .bind(&now)
            .execute(&state.pool)
            .await;
    }
}

fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    let body = ErrorResponse {
        success: false,
        error: ErrorBody {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    (status, Json(body)).into_response()
}

fn plain_error(status: StatusCode, message: &str) -> Response {
    (status, message.to_string()).into_response()
}

fn html_error(status: StatusCode, message: &str) -> Response {
    let page = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>EkSend</title><style>{}</style></head><body><main class=\"card\"><h1>EkSend</h1><p>{}</p><a href=\"/\">Upload a file</a></main></body></html>",
        base_css(),
        escape_html(message)
    );
    (status, Html(page)).into_response()
}

fn parse_duration(input: &str) -> Result<Duration, anyhow::Error> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        anyhow::bail!("empty");
    }
    let (number, unit) = trimmed.split_at(trimmed.len() - 1);
    let value: u64 = number.parse()?;
    let seconds = match unit {
        "m" => value * 60,
        "h" => value * 60 * 60,
        "d" => value * 60 * 60 * 24,
        _ => return Err(anyhow::anyhow!("invalid unit")),
    };
    Ok(Duration::from_secs(seconds))
}

fn clamp_expiry(duration: Duration, config: &AppConfig) -> (Duration, Option<String>) {
    if duration < config.min_expiry {
        return (
            config.min_expiry,
            Some(format!(
                "Expiry was below minimum; adjusted to {}.",
                duration_short(config.min_expiry)
            )),
        );
    }
    if duration > config.max_expiry {
        return (
            config.max_expiry,
            Some(format!(
                "Expiry exceeded maximum; adjusted to {}.",
                duration_short(config.max_expiry)
            )),
        );
    }
    (duration, None)
}

fn duration_short(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs % 86_400 == 0 {
        format!("{}d", secs / 86_400)
    } else if secs % 3_600 == 0 {
        format!("{}h", secs / 3_600)
    } else {
        format!("{}m", secs / 60)
    }
}

async fn generate_code(pool: &Pool<Sqlite>, config: &AppConfig) -> Result<String, anyhow::Error> {
    let mut length = config.code_min_len;
    while length <= config.code_max_len {
        for _ in 0..config.code_retries {
            let code = random_code(length);
            let exists = sqlx::query("SELECT 1 FROM uploads WHERE code = ?")
                .bind(&code)
                .fetch_optional(pool)
                .await?
                .is_some();
            if !exists {
                return Ok(code);
            }
        }
        length += 1;
    }
    Err(anyhow::anyhow!("code space exhausted"))
}

fn random_code(length: usize) -> String {
    let mut rng = rand::thread_rng();
    let mut code = String::with_capacity(length);
    while code.len() < length {
        let ch = rng.sample(Alphanumeric) as char;
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_lowercase() || lowered.is_ascii_digit() {
            if lowered != 'o' && lowered != '0' {
                code.push(lowered);
            }
        }
    }
    code
}

fn parse_datetime(value: &str) -> Result<DateTime<Utc>, anyhow::Error> {
    let parsed = DateTime::parse_from_rfc3339(value)?;
    Ok(parsed.with_timezone(&Utc))
}

fn base_url_from_headers(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("http");
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost:3000");
    format!("{scheme}://{host}")
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut idx = 0;
    while size >= 1024.0 && idx < UNITS.len() - 1 {
        size /= 1024.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{} {}", bytes, UNITS[idx])
    } else {
        format!("{:.1} {}", size, UNITS[idx])
    }
}

fn format_duration(duration: ChronoDuration) -> String {
    let seconds = duration.num_seconds();
    if seconds <= 0 {
        return "Expired".to_string();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{} minutes", minutes.max(1));
    }
    let hours = minutes / 60;
    if hours < 48 {
        return format!("{} hours", hours);
    }
    let days = hours / 24;
    format!("{} days", days)
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_upload_page() -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>EkSend</title><style>{}</style></head><body><main class=\"shell\"><header class=\"hero\"><h1>EkSend</h1><p>Drop a file, get a link. No accounts, no fuss.</p></header><section class=\"card\"><form id=\"upload-form\"><label class=\"drop\"><input type=\"file\" id=\"file\" required><span>Drag &amp; drop or click to choose a file</span></label><div class=\"row\"><label>Filename override<input type=\"text\" id=\"filename\" placeholder=\"Leave blank to keep original\"></label><label>Expiry<select id=\"expiry\"><option value=\"\">24h (default)</option><option value=\"30m\">30m</option><option value=\"1h\">1h</option><option value=\"1d\">1d</option><option value=\"7d\">7d</option></select></label></div><button type=\"submit\">Upload</button></form><div id=\"result\" class=\"result hidden\"></div></section><section class=\"notes\"><div><h2>CLI quickstart</h2><pre>curl --upload-file ./hello.txt https://eksend.com</pre></div><div><h2>Raw downloads</h2><p>Use the raw link in scripts or curl.</p></div></section></main><script>{}</script></body></html>",
        base_css(),
        upload_js()
    )
}

fn render_download_page(record: &UploadRecord, base_url: &str) -> String {
    let filename = escape_html(&record.original_filename);
    let encoded = urlencoding::encode(&record.original_filename);
    let download_url = format!("{base_url}/raw/{}/{}", record.code, encoded);
    let download_page_url = format!("{base_url}/{}/{}", record.code, encoded);
    let expires_in = format_duration(record.expires_at - Utc::now());
    let created_at = record.created_at.to_rfc3339();
    let size = human_size(record.size_bytes);

    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>EkSend</title><style>{}</style></head><body><main class=\"shell\"><header class=\"hero\"><h1>EkSend</h1><p>Here is your file.</p></header><section class=\"card\"><div class=\"file-meta\"><h2>{}</h2><p>{} · uploaded {}</p><p class=\"expiry\">Expires in {}</p></div><div class=\"actions\"><a class=\"primary\" href=\"{}\">Download</a><button data-copy=\"{}\">Copy download page</button><button data-copy=\"{}\">Copy raw link</button></div><div class=\"code\"><span>curl</span><pre>curl -O '{}'</pre></div></section></main><script>{}</script></body></html>",
        base_css(),
        filename,
        size,
        created_at,
        expires_in,
        download_url,
        download_page_url,
        download_url,
        download_url,
        download_js()
    )
}

fn base_css() -> String {
    [
        ":root{--bg:#f5f1ea;--card:#fff7ea;--ink:#1f1b16;--accent:#ff8f3f;--accent-dark:#c85b12;--muted:#6b5e52;--stroke:#e4d4c2;--shadow:0 20px 60px rgba(31,27,22,.1)}",
        "*{box-sizing:border-box}",
        "body{margin:0;font-family:'Space Grotesk','Avenir Next','Segoe UI',sans-serif;background:radial-gradient(circle at top,#ffe6c7,transparent 60%),linear-gradient(135deg,#f5f1ea,#fff);color:var(--ink)}",
        ".shell{max-width:960px;margin:0 auto;padding:48px 20px 80px;display:flex;flex-direction:column;gap:32px}",
        ".hero h1{font-size:56px;margin:0 0 12px;letter-spacing:-1px}",
        ".hero p{margin:0;color:var(--muted);font-size:18px}",
        ".card{background:var(--card);border:1px solid var(--stroke);border-radius:24px;padding:28px;box-shadow:var(--shadow)}",
        ".drop{display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;border:2px dashed #e8c7a6;border-radius:20px;padding:32px;cursor:pointer;background:rgba(255,255,255,.7)}",
        ".drop input{display:none}",
        ".row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px}",
        "label{display:flex;flex-direction:column;gap:8px;font-size:14px;color:var(--muted)}",
        "input,select{padding:12px 14px;border-radius:12px;border:1px solid var(--stroke);font-size:15px;font-family:inherit}",
        "button,.primary{margin-top:18px;padding:12px 18px;border-radius:12px;border:none;background:var(--accent);color:#1d1207;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}",
        "button:hover,.primary:hover{background:var(--accent-dark);color:#fff}",
        ".result{margin-top:20px;padding:16px;border-radius:14px;background:#fff;border:1px solid var(--stroke)}",
        ".result.hidden{display:none}",
        ".result a{color:var(--accent-dark);font-weight:600}",
        ".notes{display:grid;grid-template-columns:1fr 1fr;gap:20px}",
        ".notes h2{margin:0 0 8px;font-size:18px}",
        ".notes pre{background:#1f1b16;color:#f9efe2;padding:16px;border-radius:12px;overflow:auto}",
        ".file-meta h2{margin:0 0 8px;font-size:28px}",
        ".file-meta p{margin:6px 0;color:var(--muted)}",
        ".expiry{color:#a24c16;font-weight:600}",
        ".actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}",
        ".actions button{background:#fff;border:1px solid var(--stroke);color:var(--ink)}",
        ".actions button:hover{background:#1f1b16;color:#fff}",
        ".code{margin-top:20px;background:#1f1b16;color:#f9efe2;padding:16px;border-radius:12px}",
        ".code span{font-size:12px;text-transform:uppercase;color:#ffcf99}",
        ".code pre{margin:8px 0 0;overflow:auto}",
        ".warn{color:#a24c16;font-weight:600}",
        "@media (max-width:720px){.hero h1{font-size:40px}.row,.notes{grid-template-columns:1fr}}",
    ]
    .join("")
}

fn upload_js() -> String {
    [
        "const form=document.getElementById('upload-form');",
        "const fileInput=document.getElementById('file');",
        "const result=document.getElementById('result');",
        "const filenameInput=document.getElementById('filename');",
        "const expirySelect=document.getElementById('expiry');",
        "form.addEventListener('submit',async(e)=>{e.preventDefault();",
        "const file=fileInput.files[0];if(!file){return;}",
        "const params=new URLSearchParams();",
        "const name=filenameInput.value.trim()||file.name;",
        "if(name){params.set('name',name);}",
        "if(expirySelect.value){params.set('expires',expirySelect.value);}",
        "result.classList.remove('hidden');",
        "result.innerHTML='Uploading...';",
        "try{const res=await fetch('/?'+params.toString(),{method:'PUT',body:file});",
        "const data=await res.json();",
        "if(!data.success){throw new Error(data.error?.message||'Upload failed');}",
        r#"const warning=data.warning?`<p class="warn">${data.warning}</p>`:'';"#,
        r#"result.innerHTML=`<h3>Uploaded</h3><p><strong>${data.filename}</strong> (${Math.round(data.size_bytes/1024)} KB)</p>${warning}<p><a href="${data.download_page_url}">Download page</a></p><p><a href="${data.raw_download_url}">Raw link</a></p>`;"#,
        r#"}catch(err){result.innerHTML=`<p class="warn">${err.message}</p>`;}"#,
        "});",
    ]
    .join("")
}

fn download_js() -> String {
    [
        "document.querySelectorAll('[data-copy]').forEach(btn=>{",
        "btn.addEventListener('click',async()=>{",
        "const original=btn.textContent;",
        "const text=btn.getAttribute('data-copy');",
        "try{await navigator.clipboard.writeText(text);btn.textContent='Copied!';setTimeout(()=>btn.textContent=original,1500);}catch(_){btn.textContent='Copy failed';}",
        "});",
        "});",
    ]
    .join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_valid() {
        assert_eq!(parse_duration("30m").unwrap().as_secs(), 1800);
        assert_eq!(parse_duration("1h").unwrap().as_secs(), 3600);
        assert_eq!(parse_duration("2d").unwrap().as_secs(), 172800);
    }

    #[test]
    fn parse_duration_invalid() {
        assert!(parse_duration("").is_err());
        assert!(parse_duration("12").is_err());
        assert!(parse_duration("xm").is_err());
        assert!(parse_duration("5w").is_err());
    }

    #[test]
    fn clamp_expiry_bounds() {
        let config = AppConfig {
            data_dir: PathBuf::from("./data"),
            max_file_size: 10,
            default_expiry: Duration::from_secs(3600),
            min_expiry: Duration::from_secs(300),
            max_expiry: Duration::from_secs(3600),
            code_min_len: 3,
            code_max_len: 8,
            code_retries: 3,
        };

        let (duration, warning) = clamp_expiry(Duration::from_secs(60), &config);
        assert_eq!(duration.as_secs(), 300);
        assert!(warning.is_some());

        let (duration, warning) = clamp_expiry(Duration::from_secs(7200), &config);
        assert_eq!(duration.as_secs(), 3600);
        assert!(warning.is_some());

        let (duration, warning) = clamp_expiry(Duration::from_secs(1800), &config);
        assert_eq!(duration.as_secs(), 1800);
        assert!(warning.is_none());
    }

    #[test]
    fn duration_short_format() {
        assert_eq!(duration_short(Duration::from_secs(60 * 5)), "5m");
        assert_eq!(duration_short(Duration::from_secs(60 * 60)), "1h");
        assert_eq!(duration_short(Duration::from_secs(60 * 60 * 24 * 2)), "2d");
    }

    #[test]
    fn random_code_charset_and_length() {
        let code = random_code(6);
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()));
        assert!(!code.contains('o'));
        assert!(!code.contains('0'));
    }
}
