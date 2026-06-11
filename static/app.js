const uploadForm = document.getElementById('upload-form');
const result = document.querySelector('[data-result]');
const dropZone = document.getElementById('drop-zone');

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
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

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) {
    return;
  }
  const text = button.getAttribute('data-copy');
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
  let droppedFile = null;
  const dropLabel = dropZone?.querySelector('span');
  const DEFAULT_DROP_LABEL = dropLabel?.textContent || 'Drag & drop or click to choose a file';

  const resetUploadForm = () => {
    uploadForm.reset();
    droppedFile = null;
    if (dropLabel) {
      dropLabel.textContent = DEFAULT_DROP_LABEL;
    }
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
      droppedFile = files[0];
      if (dropLabel) {
        dropLabel.textContent = droppedFile.name;
      }
    }
  });

  ['dragenter', 'dragover', 'drop'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
    });
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput?.files?.[0];
    if (file) {
      droppedFile = file;
      if (dropLabel) {
        dropLabel.textContent = file.name;
      }
    }
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

  // XHR instead of fetch: only XMLHttpRequest exposes upload progress events
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
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
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
      <div class="upload-progress">
        <p>Uploading <strong>${label}</strong>…</p>
        <progress max="${total}" value="${loaded}"></progress>
        <span class="progress-text">${pct}% · ${humanSize(loaded)} / ${humanSize(total)}</span>
      </div>
    `;
  };

  const renderResultHtml = (data) => {
    const warning = data.warning ? `<p class="warn">${data.warning}</p>` : '';
    const hashRow = data.sha256
      ? `<div class="link-row hash-row"><span class="row-label">SHA-256</span><input type="text" readonly value="${data.sha256}"><button type="button" data-copy="${data.sha256}">Copy</button></div>`
      : '';
    const deleteRow = data.delete_url
      ? `<div class="link-row"><span class="row-label">Delete</span><input type="text" readonly value="${data.delete_url}"><button type="button" data-copy="${data.delete_url}">Copy</button></div>`
      : '';
    return `
      <h3>Uploaded</h3>
      <p><strong>${data.filename}</strong> (${Math.round(data.size_bytes / 1024)} KB)</p>
      ${warning}
      <div class="result-actions">
        <a href="${data.download_page_url}" target="_blank" rel="noopener">Open download page</a>
        <button type="button" data-reset>Upload another file</button>
      </div>
      <div class="link-list">
        <div class="link-row">
          <span class="row-label">Page</span>
          <input type="text" readonly value="${data.download_page_url}">
          <button type="button" data-copy="${data.download_page_url}">Copy</button>
        </div>
        <div class="link-row">
          <span class="row-label">Raw</span>
          <input type="text" readonly value="${data.raw_download_url}">
          <button type="button" data-copy="${data.raw_download_url}">Copy</button>
        </div>
        ${hashRow}
        ${deleteRow}
      </div>
    `;
  };

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = droppedFile || fileInput?.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      if (result) {
        result.classList.remove('hidden');
        result.innerHTML = `<p class="warn">File is too large (${humanSize(file.size)}). Maximum size is ${humanSize(MAX_FILE_SIZE)}.</p>`;
      }
      return;
    }

    const name = (filenameInput?.value || '').trim() || file.name;
    const token = (tokenInput?.value || '').trim();

    if (result) {
      result.classList.remove('hidden');
      result.innerHTML = renderProgressHtml(name, 0, file.size);
    }
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Uploading...';
    }

    try {
      const data = await uploadFile(file, {
        name,
        expires: expirySelect?.value || '',
        token,
        onProgress: (loaded, total) => {
          if (result) {
            result.innerHTML = renderProgressHtml(name, loaded, total);
          }
        },
      });
      if (result) {
        result.innerHTML = renderResultHtml(data);
      }
      uploadForm.classList.add('hidden');
    } catch (err) {
      if (result) {
        result.innerHTML = `<p class="warn">${err.message}</p>`;
      }
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Upload';
      }
    }
  });
}
