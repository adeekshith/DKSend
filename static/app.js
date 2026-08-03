const uploadForm = document.getElementById('upload-form');
const result = document.querySelector('[data-result]');
const dropZone = document.getElementById('drop-zone');

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Insecure-context fallback, NOT a legacy-browser one: navigator.clipboard
    // is undefined on plain http:// LAN IPs (it needs https or localhost) in
    // every current browser. Self-hosters serve over http, so keep this.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const ok = document.execCommand('copy');
      return ok;
    } catch (err) {
      return false;
    } finally {
      textarea.remove();
    }
  }
};

const setButtonState = (button, ok) => {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
};

// Renders the share URL as an SVG string via the vendored qrcode-generator
// (static/qr.js). Returns '' when the library failed to load.
const qrSvgTag = (text) => {
  if (typeof window.qrcode !== 'function' || !text) {
    return '';
  }
  try {
    const qr = window.qrcode(0, 'M'); // type 0 = auto-size to the data
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (_) {
    return '';
  }
};

// Download page: fill any [data-qr] placeholders with a QR of their URL
const qrHosts = document.querySelectorAll?.('[data-qr]') || [];
for (const el of qrHosts) {
  el.innerHTML = qrSvgTag(el.getAttribute('data-qr'));
}

document.addEventListener('click', async (event) => {
  // data-copy carries the text directly; data-copy-from="#id" copies that
  // element's textContent (used for the inline file contents, so a large
  // body isn't duplicated into an attribute).
  const button = event.target.closest('[data-copy], [data-copy-from]');
  if (!button) {
    return;
  }
  let text = button.getAttribute('data-copy');
  if (text === null) {
    const target = document.querySelector(button.getAttribute('data-copy-from'));
    text = target ? target.textContent : '';
  }
  if (!text) {
    return;
  }
  const ok = await copyText(text);
  setButtonState(button, ok);
});

if (uploadForm) {
  const fileInput = document.getElementById('file');
  const filenameInput = document.getElementById('filename');
  const expirySelect = document.getElementById('expiry');
  const tokenInput = document.getElementById('token');
  const textInput = document.getElementById('text-input');
  const modeTabs = uploadForm.querySelectorAll?.('[data-mode-set]') || [];
  // Selected files as { file, name } pairs: paste assigns generated names,
  // everything else keeps the file's own name
  let selectedFiles = [];
  let cardsHtml = '';

  // File vs Text input mode. CSS shows/hides the drop zone and textarea
  // off the form's data-mode attribute (same pattern as data-auth-required).
  const setMode = (mode) => {
    uploadForm.dataset.mode = mode;
    for (const tab of modeTabs) {
      tab.setAttribute('aria-pressed', tab.getAttribute('data-mode-set') === mode ? 'true' : 'false');
    }
  };
  for (const tab of modeTabs) {
    tab.addEventListener('click', () => setMode(tab.getAttribute('data-mode-set')));
  }
  const dropLabel = dropZone?.querySelector('span');
  const DEFAULT_DROP_LABEL = dropLabel?.textContent || 'Drag & drop or click to choose a file';
  const DEFAULT_OVERRIDE_PLACEHOLDER = 'Leave blank to keep original';

  const setSelectedFiles = (entries) => {
    selectedFiles = entries;
    if (dropLabel) {
      if (entries.length === 0) {
        dropLabel.textContent = DEFAULT_DROP_LABEL;
      } else if (entries.length === 1) {
        dropLabel.textContent = entries[0].name || entries[0].file.name;
      } else {
        dropLabel.textContent = `${entries.length} files selected`;
      }
    }
    if (filenameInput) {
      // The override names exactly one file; disable it for batches
      if (entries.length > 1) {
        filenameInput.disabled = true;
        filenameInput.value = '';
        filenameInput.placeholder = 'Per-file names kept (multiple files)';
      } else {
        filenameInput.disabled = false;
        filenameInput.placeholder = DEFAULT_OVERRIDE_PLACEHOLDER;
      }
    }
  };

  const wrapFiles = (files) => Array.from(files || []).map((file) => ({ file, name: file.name }));

  const resetUploadForm = () => {
    uploadForm.reset();
    cardsHtml = '';
    setSelectedFiles([]);
    setMode('file');
    if (result) {
      result.classList.add('hidden');
      result.innerHTML = '';
    }
    uploadForm.classList.remove('hidden');
  };

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-reset]')) {
      resetUploadForm();
    }
  });

  const setDragging = (active) => {
    if (dropZone) {
      dropZone.classList.toggle('dragging', active);
    }
  };

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(true);
    });
  });

  ['dragleave', 'dragend'].forEach((eventName) => {
    dropZone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
    });
  });

  dropZone?.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      setSelectedFiles(wrapFiles(files));
    }
  });

  ['dragenter', 'dragover', 'drop'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
    });
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput?.files?.length) {
      setSelectedFiles(wrapFiles(fileInput.files));
    }
  });

  const pastedFilename = (mime) => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const subtype = (mime || '').split('/')[1] || '';
    const ext = subtype.split('+')[0] || 'bin';
    return `pasted-${stamp}.${ext}`;
  };

  document.addEventListener('paste', (event) => {
    const files = event.clipboardData?.files;
    if (!files || !files.length) {
      // Text pastes (auth token, filename override) stay untouched
      return;
    }
    event.preventDefault();
    setSelectedFiles(
      Array.from(files).map((file) => ({ file, name: pastedFilename(file.type) })),
    );
  });

  // Server injects its real limit via data-max-file-size; the constant is
  // only a fallback if the attribute is missing
  const MAX_FILE_SIZE = Number(uploadForm.dataset.maxFileSize) || 200 * 1024 * 1024;
  const submitButton = uploadForm.querySelector('button[type="submit"]');

  const humanSize = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
      size /= 1024;
      idx += 1;
    }
    return idx === 0 ? `${bytes} ${units[idx]}` : `${size.toFixed(1)} ${units[idx]}`;
  };

  // XHR instead of fetch: only XMLHttpRequest exposes upload progress events.
  // fetch() upload progress (duplex streaming request bodies) is still
  // Chromium-only and HTTPS-only as of 2026, so XHR stays.
  const uploadFile = (file, { name, expires, token, onProgress }) =>
    new Promise((resolve, reject) => {
      const params = new URLSearchParams();
      if (name) {
        params.set('name', name);
      }
      if (expires) {
        params.set('expires', expires);
      }
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/?' + params.toString());
      if (token) {
        // X-Upload-Token instead of Authorization: reverse proxies with
        // auth middleware intercept Authorization and reject the request
        // with their own non-JSON error page
        xhr.setRequestHeader('X-Upload-Token', token);
      }
      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress(event.loaded, event.total);
          }
        };
      }
      xhr.onload = () => {
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (_) {
          reject(new Error('Unexpected server response'));
          return;
        }
        if (data.success) {
          resolve(data);
        } else {
          reject(new Error(data.error?.message || 'Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });

  const renderProgressHtml = (label, loaded, total) => {
    const pct = total ? Math.floor((loaded / total) * 100) : 0;
    return `
      <div class="upload-progress" role="status" aria-live="polite">
        <p>Uploading <strong>${label}</strong>…</p>
        <progress max="${total}" value="${loaded}"></progress>
        <span class="progress-text">${pct}% · ${humanSize(loaded)} / ${humanSize(total)}</span>
      </div>
    `;
  };

  const renderResultCard = (data) => {
    // The server-side expiry clamp is an adjustment, not a failure.
    const warning = data.warning ? `<p class="notice-warn">${data.warning}</p>` : '';
    const hashRow = data.sha256
      ? `<div class="link-row hash-row"><span class="row-label">SHA-256</span><input type="text" readonly value="${data.sha256}"><button type="button" class="btn btn-secondary" data-copy="${data.sha256}">Copy</button></div>`
      : '';
    const deleteRow = data.delete_url
      ? `<div class="link-row"><span class="row-label">Delete</span><input type="text" readonly value="${data.delete_url}"><button type="button" class="btn btn-secondary" data-copy="${data.delete_url}">Copy</button></div>`
      : '';
    return `
      <div class="file-card">
        <p><strong>${data.filename}</strong> (${Math.round(data.size_bytes / 1024)} KB)</p>
        ${warning}
        <div class="result-actions">
          <a class="btn btn-secondary" href="${data.download_page_url}" target="_blank" rel="noopener">Open download page</a>
        </div>
        <div class="qr-block" role="img" aria-label="QR code for this share link">${qrSvgTag(data.download_page_url)}</div>
        <div class="link-list">
          <div class="link-row">
            <span class="row-label">Page</span>
            <input type="text" readonly value="${data.download_page_url}">
            <button type="button" class="btn btn-secondary" data-copy="${data.download_page_url}">Copy</button>
          </div>
          <div class="link-row">
            <span class="row-label">Raw</span>
            <input type="text" readonly value="${data.raw_download_url}">
            <button type="button" class="btn btn-secondary" data-copy="${data.raw_download_url}">Copy</button>
          </div>
          ${hashRow}
          ${deleteRow}
        </div>
      </div>
    `;
  };

  const renderErrorCard = (name, message) => `
    <div class="file-card file-card-error">
      <p><strong>${name}</strong></p>
      <p class="notice-danger">${message}</p>
    </div>
  `;

  // Exactly one h3 and one reset button regardless of file count
  const renderSummaryHtml = () => `
    <h3>Uploaded</h3>
    <div class="result-actions">
      <button type="button" class="btn btn-secondary" data-reset>Upload another file</button>
    </div>
  `;

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const override = (filenameInput?.value || '').trim();

    let entries;
    if (uploadForm.dataset.mode === 'text') {
      // Text mode: wrap the textarea as a text/plain blob and reuse the file
      // path. uploadFile only reads .size and sends the body (the name rides
      // the ?name= param), so a Blob is enough — no File global needed.
      const text = textInput?.value || '';
      if (!text.trim()) {
        return;
      }
      const blob = new Blob([text], { type: 'text/plain' });
      entries = [{ file: blob, name: override || 'note.txt' }];
    } else {
      entries = selectedFiles.length ? selectedFiles : wrapFiles(fileInput?.files);
    }
    if (!entries.length) {
      return;
    }

    const token = (tokenInput?.value || '').trim();
    cardsHtml = '';
    let successCount = 0;

    if (result) {
      result.classList.remove('hidden');
    }
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Uploading...';
    }

    for (let i = 0; i < entries.length; i++) {
      const { file } = entries[i];
      // The override only ever applies to a single selected file
      const name = entries.length === 1 && override ? override : entries[i].name || file.name;
      const label = entries.length > 1 ? `${name} (file ${i + 1} of ${entries.length})` : name;

      if (file.size > MAX_FILE_SIZE) {
        cardsHtml += renderErrorCard(
          name,
          `File is too large (${humanSize(file.size)}). Maximum size is ${humanSize(MAX_FILE_SIZE)}.`,
        );
        if (result) {
          result.innerHTML = cardsHtml;
        }
        continue;
      }

      if (result) {
        result.innerHTML = renderProgressHtml(label, 0, file.size) + cardsHtml;
      }
      try {
        const data = await uploadFile(file, {
          name,
          expires: expirySelect?.value || '',
          token,
          onProgress: (loaded, total) => {
            if (result) {
              result.innerHTML = renderProgressHtml(label, loaded, total) + cardsHtml;
            }
          },
        });
        successCount += 1;
        cardsHtml += renderResultCard(data);
      } catch (err) {
        // One failed file must not abort the rest of the batch
        cardsHtml += renderErrorCard(name, err.message);
      }
      if (result) {
        result.innerHTML = cardsHtml;
      }
    }

    if (result) {
      result.innerHTML = (successCount > 0 ? renderSummaryHtml() : '') + cardsHtml;
    }
    if (successCount > 0) {
      uploadForm.classList.add('hidden');
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Upload';
    }
  });
}
