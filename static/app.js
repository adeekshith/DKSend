const uploadForm = document.getElementById('upload-form');
const result = document.querySelector('[data-result]');

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

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput?.files?.[0];
    if (!file) {
      return;
    }
    const params = new URLSearchParams();
    const name = (filenameInput?.value || '').trim() || file.name;
    if (name) {
      params.set('name', name);
    }
    if (expirySelect?.value) {
      params.set('expires', expirySelect.value);
    }

    if (result) {
      result.classList.remove('hidden');
      result.innerHTML = 'Uploading...';
    }

    try {
      const res = await fetch('/?' + params.toString(), { method: 'PUT', body: file });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error?.message || 'Upload failed');
      }
      const warning = data.warning ? `<p class="warn">${data.warning}</p>` : '';
      if (result) {
        result.innerHTML = `
          <h3>Uploaded</h3>
          <p><strong>${data.filename}</strong> (${Math.round(data.size_bytes / 1024)} KB)</p>
          ${warning}
          <div class="result-actions">
            <a href="${data.download_page_url}">Open download page</a>
            <button type="button" data-copy="${data.download_page_url}">Copy download page</button>
            <button type="button" data-copy="${data.raw_download_url}">Copy raw link</button>
          </div>
        `;
      }
    } catch (err) {
      if (result) {
        result.innerHTML = `<p class="warn">${err.message}</p>`;
      }
    }
  });
}
