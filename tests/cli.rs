// Binary-level test: the server must refuse to start when the files
// directory exists but is not writable (the post-non-root-upgrade state),
// instead of failing later on the first upload.

#[cfg(unix)]
#[test]
fn startup_fails_fast_when_files_dir_not_writable() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::process::Command;

    let tmp = tempfile::tempdir().unwrap();

    // Root bypasses directory permissions (the Docker unit-test image runs
    // cargo test as root), so the failure path is untestable there.
    let marker = tmp.path().join("uid-marker");
    std::fs::write(&marker, b"").unwrap();
    if std::fs::metadata(&marker).unwrap().uid() == 0 {
        eprintln!("skipping startup_fails_fast_when_files_dir_not_writable: running as root");
        return;
    }

    let files = tmp.path().join("files");
    std::fs::create_dir_all(&files).unwrap();
    let mut perms = std::fs::metadata(&files).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&files, perms).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_dksend"))
        .env("DATA_DIR", tmp.path())
        .env("PORT", "0")
        .env("ACCESS_LOG", "0")
        // Templates load from static/ relative to the working directory
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "server must exit non-zero on an unwritable files dir"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("is not writable"), "stderr: {stderr}");
    assert!(stderr.contains("chown -R 1000:1000"), "stderr: {stderr}");

    // Restore permissions so tempdir cleanup succeeds
    let mut restore = std::fs::metadata(&files).unwrap().permissions();
    restore.set_mode(0o755);
    std::fs::set_permissions(&files, restore).unwrap();
}
