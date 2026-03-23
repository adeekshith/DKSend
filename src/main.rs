use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, get_service},
    Router,
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
use tokio_util::io::ReaderStream;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

#[derive(Clone)]
struct AppState {
    pool: Pool<Sqlite>,
    config: AppConfig,
    templates: Templates,
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
    brand_title: String,
    brand_description: String,
}

#[derive(Clone)]
struct Templates {
    upload: String,
    download: String,
    error: String,
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
    format: Option<String>,
    output: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadResponseMode {
    Json,
    Plain,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("DKSend error: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), anyhow::Error> {
    let config = load_config()?;
    let templates = load_templates().await?;
    let db_path = config.data_dir.join("uploads.db");
    eprintln!(
        "DKSend startup: data_dir={}, db_path={}, max_file_size={}, default_expiry_secs={}, max_expiry_secs={}, brand_title=\"{}\"",
        config.data_dir.display(),
        db_path.display(),
        config.max_file_size,
        config.default_expiry.as_secs(),
        config.max_expiry.as_secs(),
        config.brand_title
    );
    fs::create_dir_all(config.data_dir.join("files")).await?;

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await?;

    eprintln!("DKSend: running migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    eprintln!("DKSend: migrations complete");

    let brand_title = config.brand_title.clone();
    let state = AppState {
        pool,
        config,
        templates,
    };

    let static_service = get_service(ServeDir::new("static")).layer(
        SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        ),
    );

    let app = Router::new()
        .route("/", get(upload_page).put(upload_handler))
        .nest_service("/static", static_service)
        .route("/raw/:code", get(raw_download_code))
        .route("/raw/:code/:filename", get(raw_download_named))
        .route("/:code", get(download_page_code).put(upload_handler_named))
        .route("/:code/:filename", get(download_page_named))
        .with_state(state.clone());

    let cleanup_state = state.clone();
    tokio::spawn(async move {
        cleanup_loop(cleanup_state).await;
    });

    let listen_addr = "0.0.0.0:3000";
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    println!("{} listening on http://{listen_addr}", brand_title);
    axum::serve(listener, app).await?;

    Ok(())
}


async fn load_templates() -> Result<Templates, anyhow::Error> {
    let upload = fs::read_to_string("static/upload.html").await?;
    let download = fs::read_to_string("static/download.html").await?;
    let error = fs::read_to_string("static/error.html").await?;
    Ok(Templates {
        upload,
        download,
        error,
    })
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

    // Default heading is generic; operators can override via BRAND_TITLE
    let brand_title = env::var("BRAND_TITLE").unwrap_or_else(|_| "Send Files".to_string());
    // Tagline is empty by default; set BRAND_DESCRIPTION to add one
    let brand_description = env::var("BRAND_DESCRIPTION").unwrap_or_default();

    Ok(AppConfig {
        data_dir: PathBuf::from(data_dir),
        max_file_size,
        default_expiry,
        min_expiry,
        max_expiry,
        code_min_len: 3,
        code_max_len: 8,
        code_retries: 5,
        brand_title,
        brand_description,
    })
}

async fn upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<UploadQuery>,
    body: Body,
) -> Response {
    handle_upload(state, headers, params, body).await
}

async fn upload_handler_named(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(filename): Path<String>,
    Query(mut params): Query<UploadQuery>,
    body: Body,
) -> Response {
    if params
        .name
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        params.name = Some(filename);
    }
    handle_upload(state, headers, params, body).await
}

async fn handle_upload(
    state: AppState,
    headers: HeaderMap,
    params: UploadQuery,
    body: Body,
) -> Response {
    let response_mode = upload_response_mode(&headers, &params);
    let content_length = match headers.get(header::CONTENT_LENGTH) {
        Some(value) => match value.to_str().ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(length) => length,
            None => {
                return upload_error(
                    response_mode,
                    StatusCode::BAD_REQUEST,
                    "CONTENT_LENGTH_INVALID",
                    "Content-Length must be a valid number.",
                )
            }
        },
        None => {
            return upload_error(
                response_mode,
                StatusCode::BAD_REQUEST,
                "CONTENT_LENGTH_REQUIRED",
                "Content-Length header is required.",
            )
        }
    };

    if content_length == 0 {
        return upload_error(
            response_mode,
            StatusCode::BAD_REQUEST,
            "FILE_EMPTY",
            "Cannot upload an empty file.",
        );
    }

    if content_length > state.config.max_file_size {
        return upload_error(
            response_mode,
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
                return upload_error(
                    response_mode,
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
            return upload_error(
                response_mode,
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
            return upload_error(
                response_mode,
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
                return upload_error(
                    response_mode,
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "UPLOAD_STREAM_ERROR",
                    "Failed while reading the upload stream.",
                );
            }
        };
        size_written += chunk.len() as u64;
        if size_written > state.config.max_file_size {
            let _ = fs::remove_file(&file_path).await;
            return upload_error(
                response_mode,
                StatusCode::PAYLOAD_TOO_LARGE,
                "FILE_TOO_LARGE",
                "File exceeds the configured size limit.",
            );
        }
        if let Err(_) = file.write_all(&chunk).await {
            let _ = fs::remove_file(&file_path).await;
            return upload_error(
                response_mode,
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
        return upload_error(
            response_mode,
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
        download_page_url: download_page_url.clone(),
        raw_download_url,
        warning,
    };

    match response_mode {
        UploadResponseMode::Json => json_response(StatusCode::CREATED, &response),
        UploadResponseMode::Plain => (StatusCode::CREATED, format!("{download_page_url}\n")).into_response(),
    }
}

async fn upload_page(State(state): State<AppState>) -> Html<String> {
    Html(render_upload_page(&state.templates, &state.config))
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
        Ok(None) => {
            return html_error(
                StatusCode::NOT_FOUND,
                "This file does not exist.",
                &state.templates,
                &state.config,
            )
        }
        Err(_) => {
            return html_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong while loading this file.",
                &state.templates,
                &state.config,
            )
        }
    };

    if record.expires_at <= Utc::now() {
        return html_error(
            StatusCode::GONE,
            "This file does not exist or is no longer available.",
            &state.templates,
            &state.config,
        );
    }

    let canonical_filename = record.original_filename.clone();
    let encoded = urlencoding::encode(&canonical_filename);
    let base_url = base_url_from_headers(&headers);
    let canonical_url = format!("{base_url}/{code}/{encoded}");

    if filename.as_deref() != Some(&canonical_filename) {
        return Redirect::temporary(&canonical_url).into_response();
    }

    Html(render_download_page(&record, &base_url, &state.templates, &state.config)).into_response()
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
            Err(err) => {
                eprintln!("cleanup: failed to query expired uploads: {err}");
                continue;
            }
        };

        if rows.is_empty() {
            continue;
        }

        eprintln!("cleanup: removing {} expired upload(s)", rows.len());

        // Delete DB records first — orphaned files on disk are less harmful
        // than dangling DB records pointing to missing files.
        if let Err(err) = sqlx::query("DELETE FROM uploads WHERE expires_at <= ?")
            .bind(&now)
            .execute(&state.pool)
            .await
        {
            eprintln!("cleanup: failed to delete expired records: {err}");
        }

        for row in rows {
            let stored_path: String = match row.try_get("stored_path") {
                Ok(path) => path,
                Err(_) => continue,
            };
            if let Err(err) = fs::remove_file(&stored_path).await {
                eprintln!("cleanup: failed to remove file {stored_path}: {err}");
            }
        }
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
    json_response(status, &body)
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn upload_error(mode: UploadResponseMode, status: StatusCode, code: &str, message: &str) -> Response {
    match mode {
        UploadResponseMode::Json => json_error(status, code, message),
        UploadResponseMode::Plain => plain_error(status, message),
    }
}

fn plain_error(status: StatusCode, message: &str) -> Response {
    (status, message.to_string()).into_response()
}

fn html_error(status: StatusCode, message: &str, templates: &Templates, config: &AppConfig) -> Response {
    let title = escape_html(&config.brand_title);
    let page = render_template(
        &templates.error,
        &[
            ("{{title}}", title.clone()),
            ("{{message}}", escape_html(message)),
        ],
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

fn upload_response_mode(headers: &HeaderMap, params: &UploadQuery) -> UploadResponseMode {
    let forced = params
        .output
        .as_deref()
        .or(params.format.as_deref())
        .map(|value| value.trim().to_ascii_lowercase());
    if let Some(value) = forced {
        if value == "plain" || value == "text" {
            return UploadResponseMode::Plain;
        }
        if value == "json" {
            return UploadResponseMode::Json;
        }
    }

    if let Some(accept) = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
    {
        let accept_lower = accept.to_ascii_lowercase();
        let wants_plain = accept_lower
            .split(',')
            .any(|value| value.trim().starts_with("text/plain"));
        let wants_json = accept_lower.contains("application/json");
        if wants_plain && !wants_json {
            return UploadResponseMode::Plain;
        }
    }

    UploadResponseMode::Json
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

fn render_template(template: &str, replacements: &[(&str, String)]) -> String {
    let mut output = template.to_string();
    for (key, value) in replacements {
        output = output.replace(key, value);
    }
    output
}

fn render_upload_page(templates: &Templates, config: &AppConfig) -> String {
    let title = escape_html(&config.brand_title);
    let description = escape_html(&config.brand_description);
    render_template(
        &templates.upload,
        &[
            ("{{title}}", title),
            ("{{description}}", description),
        ],
    )
}

fn render_download_page(
    record: &UploadRecord,
    base_url: &str,
    templates: &Templates,
    config: &AppConfig,
) -> String {
    let title = escape_html(&config.brand_title);
    let description = escape_html(&config.brand_description);
    let filename = escape_html(&record.original_filename);
    let encoded = urlencoding::encode(&record.original_filename);
    let download_url = format!("{base_url}/raw/{}/{}", record.code, encoded);
    let download_page_url = format!("{base_url}/{}/{}", record.code, encoded);
    let expires_in = format_duration(record.expires_at - Utc::now());
    let created_at = record.created_at.to_rfc3339();
    let size = human_size(record.size_bytes);

    render_template(
        &templates.download,
        &[
            ("{{title}}", title),
            ("{{description}}", description),
            ("{{filename}}", filename),
            ("{{size}}", size),
            ("{{created_at}}", created_at),
            ("{{expires_in}}", expires_in),
            ("{{download_url}}", download_url.clone()),
            ("{{download_page_url}}", download_page_url),
            ("{{curl_url}}", download_url),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn test_state(tmp: &std::path::Path) -> AppState {
        let data_dir = tmp.join("data");
        tokio::fs::create_dir_all(data_dir.join("files")).await.unwrap();
        let db_path = data_dir.join("uploads.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let templates = load_templates().await.unwrap();
        let config = AppConfig {
            data_dir,
            max_file_size: 1024 * 1024,
            default_expiry: Duration::from_secs(3600),
            min_expiry: Duration::from_secs(300),
            max_expiry: Duration::from_secs(86400),
            code_min_len: 3,
            code_max_len: 8,
            code_retries: 5,
            brand_title: "Test".to_string(),
            brand_description: "Test instance".to_string(),
        };
        AppState { pool, config, templates }
    }

    fn test_app(state: AppState) -> Router {
        Router::new()
            .route("/", get(upload_page).put(upload_handler))
            .route("/:code", get(download_page_code).put(upload_handler_named))
            .route("/:code/:filename", get(download_page_named))
            .route("/raw/:code", get(raw_download_code))
            .route("/raw/:code/:filename", get(raw_download_named))
            .with_state(state)
    }

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
            brand_title: "DKSend".to_string(),
            brand_description: "Drop a file, get a link.".to_string(),
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

    #[test]
    fn upload_response_mode_defaults_to_json() {
        let headers = HeaderMap::new();
        let params = UploadQuery {
            expires: None,
            name: None,
            format: None,
            output: None,
        };
        assert_eq!(upload_response_mode(&headers, &params), UploadResponseMode::Json);
    }

    #[test]
    fn upload_response_mode_accept_plain_text() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/plain"));
        let params = UploadQuery {
            expires: None,
            name: None,
            format: None,
            output: None,
        };
        assert_eq!(upload_response_mode(&headers, &params), UploadResponseMode::Plain);
    }

    #[test]
    fn upload_response_mode_accept_plain_and_json_prefers_json() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("text/plain, application/json"),
        );
        let params = UploadQuery {
            expires: None,
            name: None,
            format: None,
            output: None,
        };
        assert_eq!(upload_response_mode(&headers, &params), UploadResponseMode::Json);
    }

    #[test]
    fn upload_response_mode_output_plain_overrides_accept() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
        let params = UploadQuery {
            expires: None,
            name: None,
            format: None,
            output: Some(" plain ".to_string()),
        };
        assert_eq!(upload_response_mode(&headers, &params), UploadResponseMode::Plain);
    }

    #[test]
    fn upload_response_mode_format_json_overrides_accept() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/plain"));
        let params = UploadQuery {
            expires: None,
            name: None,
            format: Some("json".to_string()),
            output: None,
        };
        assert_eq!(upload_response_mode(&headers, &params), UploadResponseMode::Json);
    }

    #[test]
    fn upload_page_file_input_not_required() {
        let templates = Templates {
            upload: std::fs::read_to_string("static/upload.html").unwrap(),
            download: String::new(),
            error: String::new(),
        };
        let config = AppConfig {
            data_dir: PathBuf::from("./data"),
            max_file_size: 1024,
            default_expiry: Duration::from_secs(3600),
            min_expiry: Duration::from_secs(300),
            max_expiry: Duration::from_secs(86400),
            code_min_len: 3,
            code_max_len: 8,
            code_retries: 3,
            brand_title: "Test".to_string(),
            brand_description: "Test".to_string(),
        };
        let html = render_upload_page(&templates, &config);
        assert!(
            !html.contains(r#"type="file" required"#) && !html.contains(r#"type="file"  required"#),
            "file input must not have the required attribute (breaks drag-and-drop)"
        );
        assert!(html.contains(r#"id="drop-zone""#));
        assert!(html.contains(r#"type="file""#));
    }

    #[tokio::test]
    async fn upload_page_returns_html() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let response = app
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("drop-zone"));
        assert!(html.contains("upload-form"));
    }

    #[tokio::test]
    async fn upload_file_via_put() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let body = "hello world";
        let response = app
            .oneshot(
                Request::put("/?name=test.txt")
                    .header("content-length", body.len().to_string())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["success"], true);
        assert_eq!(data["filename"], "test.txt");
        assert_eq!(data["size_bytes"], body.len());
        assert!(data["code"].as_str().unwrap().len() >= 3);
        assert!(data["download_page_url"].as_str().unwrap().contains("test.txt"));
        assert!(data["raw_download_url"].as_str().unwrap().contains("/raw/"));
    }

    #[tokio::test]
    async fn upload_requires_content_length() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let response = app
            .oneshot(
                Request::put("/")
                    .body(Body::from("data"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["success"], false);
        assert_eq!(data["error"]["code"], "CONTENT_LENGTH_REQUIRED");
    }

    #[tokio::test]
    async fn upload_empty_file_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let response = app
            .oneshot(
                Request::put("/?name=empty.txt")
                    .header("content-length", "0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["error"]["code"], "FILE_EMPTY");
    }

    #[tokio::test]
    async fn upload_file_too_large() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let response = app
            .oneshot(
                Request::put("/?name=big.bin")
                    .header("content-length", "99999999")
                    .body(Body::from("x"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn upload_and_download() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;

        let content = "download me";
        let upload_resp = test_app(state.clone())
            .oneshot(
                Request::put("/?name=hello.txt")
                    .header("content-length", content.len().to_string())
                    .body(Body::from(content))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(upload_resp.status(), StatusCode::CREATED);
        let bytes = upload_resp.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let code = data["code"].as_str().unwrap();

        let raw_path = format!("/raw/{}/hello.txt", code);
        let download_resp = test_app(state)
            .oneshot(Request::get(&raw_path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(download_resp.status(), StatusCode::OK);
        let body = download_resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.as_ref(), content.as_bytes());
    }

    #[tokio::test]
    async fn upload_with_expiry() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let body = "data";
        let response = app
            .oneshot(
                Request::put("/?name=f.txt&expires=30m")
                    .header("content-length", body.len().to_string())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["success"], true);
        assert!(data["expires_in_seconds"].as_i64().unwrap() <= 1800);
        assert!(data["expires_in_seconds"].as_i64().unwrap() > 1700);
    }

    #[tokio::test]
    async fn upload_plain_text_response() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let body = "data";
        let response = app
            .oneshot(
                Request::put("/?name=f.txt")
                    .header("content-length", body.len().to_string())
                    .header("accept", "text/plain")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("/f.txt"));
        assert!(text.ends_with('\n'));
        assert!(!text.contains('{'));
    }

    #[tokio::test]
    async fn upload_named_route() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let app = test_app(state);

        let body = "named";
        let response = app
            .oneshot(
                Request::put("/myfile.txt")
                    .header("content-length", body.len().to_string())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["filename"], "myfile.txt");
    }
}
