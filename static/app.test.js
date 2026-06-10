import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimal DOM mock for testing app.js event wiring
class MockElement {
  constructor(tag, attrs = {}) {
    this.tagName = tag;
    this.id = attrs.id || '';
    this.type = attrs.type || '';
    this.required = attrs.required || false;
    this.classList = new MockClassList();
    this.children = [];
    this._listeners = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.dataset = {};
    this.files = [];
    this.style = {};
  }
  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }
  dispatchEvent(event) {
    const handlers = this._listeners[event.type] || [];
    for (const h of handlers) h(event);
  }
  querySelector(sel) {
    if (sel === 'span') return this.children.find((c) => c.tagName === 'span') || null;
    if (sel === '[data-result]') return null;
    if (sel === 'button[type="submit"]') {
      return this.children.find((c) => c.tagName === 'button' && c.type === 'submit') || null;
    }
    return null;
  }
  getElementById(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.getElementById?.(id);
      if (found) return found;
    }
    return null;
  }
  closest() {
    return null;
  }
  remove() {}
  focus() {}
  select() {}
  reset() {
    this.value = '';
    this.files = [];
  }
  createElement(tag) {
    return new MockElement(tag);
  }
  appendChild(child) {
    this.children.push(child);
  }
}

class MockClassList {
  constructor() {
    this._classes = new Set();
  }
  add(cls) {
    this._classes.add(cls);
  }
  remove(cls) {
    this._classes.delete(cls);
  }
  toggle(cls, force) {
    if (force) this._classes.add(cls);
    else this._classes.delete(cls);
  }
  contains(cls) {
    return this._classes.has(cls);
  }
}

function makeEvent(type, extra = {}) {
  return { type, preventDefault() {}, stopPropagation() {}, ...extra };
}

function makeDom() {
  const spanEl = new MockElement('span');
  spanEl.textContent = 'Drag & drop or click to choose a file';

  const fileInput = new MockElement('input', { id: 'file', type: 'file' });
  const dropZone = new MockElement('label', { id: 'drop-zone' });
  dropZone.children.push(spanEl);

  const filenameInput = new MockElement('input', { id: 'filename' });
  const expirySelect = new MockElement('select', { id: 'expiry' });
  expirySelect.value = '';
  const tokenInput = new MockElement('input', { id: 'token', type: 'password' });

  const submitBtn = new MockElement('button', { id: 'submit-btn', type: 'submit' });
  submitBtn.textContent = 'Upload';
  const uploadForm = new MockElement('form', { id: 'upload-form' });
  uploadForm.children.push(submitBtn);
  const resultDiv = new MockElement('div', { id: 'result' });

  const elements = { 'upload-form': uploadForm, file: fileInput, 'drop-zone': dropZone, filename: filenameInput, expiry: expirySelect, token: tokenInput, result: resultDiv };

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector(sel) {
      if (sel === '[data-result]') return resultDiv;
      return null;
    },
    addEventListener(event, handler) {
      if (!document._listeners[event]) document._listeners[event] = [];
      document._listeners[event].push(handler);
    },
    _listeners: {},
    createElement(tag) { return new MockElement(tag); },
    body: new MockElement('body'),
    execCommand() { return true; },
  };

  return { document, uploadForm, fileInput, dropZone, filenameInput, expirySelect, tokenInput, resultDiv, spanEl, submitBtn };
}

function loadApp(dom) {
  const { document, uploadForm } = dom;
  // Inject globals and evaluate app.js
  const code = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const wrapped = new Function('document', 'navigator', 'fetch', 'setTimeout', 'window', code);
  let lastFetchArgs = null;
  const fakeFetch = async (...args) => {
    lastFetchArgs = args;
    return {
      json: async () => ({
        success: true,
        code: 'abc',
        filename: 'test.txt',
        size_bytes: 100,
        download_page_url: 'http://localhost/abc',
        raw_download_url: 'http://localhost/raw/abc/test.txt',
        sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
        delete_token: 'tok123tok123tok123tok123tok12312',
        delete_url: 'http://localhost/delete/abc?token=tok123tok123tok123tok123tok12312',
      }),
    };
  };
  const fakeNav = { clipboard: { writeText: async () => {} } };
  wrapped(document, fakeNav, fakeFetch, (fn) => fn(), {});
  return { getLastFetch: () => lastFetchArgs };
}

describe('drag and drop upload', () => {
  let dom, ctx;

  beforeEach(() => {
    dom = makeDom();
    ctx = loadApp(dom);
  });

  it('sets dragging class on dragenter', () => {
    dom.dropZone.dispatchEvent(makeEvent('dragenter'));
    assert.ok(dom.dropZone.classList.contains('dragging'));
  });

  it('sets dragging class on dragover', () => {
    dom.dropZone.dispatchEvent(makeEvent('dragover'));
    assert.ok(dom.dropZone.classList.contains('dragging'));
  });

  it('removes dragging class on dragleave', () => {
    dom.dropZone.classList.add('dragging');
    dom.dropZone.dispatchEvent(makeEvent('dragleave'));
    assert.ok(!dom.dropZone.classList.contains('dragging'));
  });

  it('removes dragging class on dragend', () => {
    dom.dropZone.classList.add('dragging');
    dom.dropZone.dispatchEvent(makeEvent('dragend'));
    assert.ok(!dom.dropZone.classList.contains('dragging'));
  });

  it('accepts dropped file and updates label', () => {
    const file = { name: 'photo.png', size: 1024 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    assert.equal(dom.spanEl.textContent, 'photo.png');
  });

  it('removes dragging class after drop', () => {
    dom.dropZone.classList.add('dragging');
    const file = { name: 'photo.png', size: 1024 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    assert.ok(!dom.dropZone.classList.contains('dragging'));
  });

  it('submits dropped file via fetch', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    // Submit the form
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    // Give the async handler a tick
    await new Promise((r) => setTimeout(r, 10));
    const [url, opts] = ctx.getLastFetch();
    assert.ok(url.includes('name=doc.pdf'));
    assert.equal(opts.method, 'PUT');
    assert.equal(opts.body, file);
  });

  it('prefers filename override for dropped file', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.filenameInput.value = 'custom.pdf';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url] = ctx.getLastFetch();
    assert.ok(url.includes('name=custom.pdf'));
  });

  it('accepts file via file input change', async () => {
    const file = { name: 'input.txt', size: 512 };
    dom.fileInput.files = [file];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    assert.equal(dom.spanEl.textContent, 'input.txt');

    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url, opts] = ctx.getLastFetch();
    assert.ok(url.includes('name=input.txt'));
    assert.equal(opts.body, file);
  });

  it('does not submit without a file', async () => {
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.getLastFetch(), null);
  });

  it('rejects files exceeding max size', async () => {
    const bigFile = { name: 'huge.bin', size: 300 * 1024 * 1024 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [bigFile] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.getLastFetch(), null);
    assert.ok(dom.resultDiv.innerHTML.includes('too large'));
  });

  it('disables submit button during upload', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    // Button should be disabled immediately
    assert.equal(dom.submitBtn.disabled, true);
    assert.equal(dom.submitBtn.textContent, 'Uploading...');
    await new Promise((r) => setTimeout(r, 10));
    // Button should be re-enabled after upload completes
    assert.equal(dom.submitBtn.disabled, false);
    assert.equal(dom.submitBtn.textContent, 'Upload');
  });

  it('renders Page, Raw, SHA-256, and Delete labels in the result block', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const html = dom.resultDiv.innerHTML;
    assert.ok(html.includes('>Page<'), 'should label the page URL row');
    assert.ok(html.includes('>Raw<'), 'should label the raw URL row');
    assert.ok(html.includes('>SHA-256<'), 'should label the sha256 row');
    assert.ok(html.includes('>Delete<'), 'should label the delete URL row');
    // All labels share the same row-label class so they align horizontally
    const labelMatches = html.match(/class="row-label"/g) || [];
    assert.equal(labelMatches.length, 4, 'expected four row-label spans');
  });

  it('renders the delete link with a copy button', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const html = dom.resultDiv.innerHTML;
    assert.ok(
      html.includes('data-copy="http://localhost/delete/abc?token='),
      'delete URL should be copyable',
    );
  });

  it('opens the download page link in a new tab', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const html = dom.resultDiv.innerHTML;
    assert.ok(html.includes('target="_blank"'), 'download link should open in a new tab');
    assert.ok(html.includes('rel="noopener"'), 'download link should set rel=noopener');
  });

  it('hides the upload form after a successful upload', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    assert.ok(!dom.uploadForm.classList.contains('hidden'), 'form is visible before upload');
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom.uploadForm.classList.contains('hidden'), 'form is hidden after upload');
  });

  it('renders an "Upload another file" button in the result block', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom.resultDiv.innerHTML.includes('data-reset'), 'result should contain a reset button');
  });

  it('restores the form when "Upload another file" is clicked', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom.uploadForm.classList.contains('hidden'));

    // Simulate clicking the [data-reset] button (delegated on document)
    const resetEvent = makeEvent('click', {
      target: { closest: (sel) => (sel === '[data-reset]' ? {} : null) },
    });
    for (const handler of dom.document._listeners.click || []) {
      await handler(resetEvent);
    }

    assert.ok(!dom.uploadForm.classList.contains('hidden'), 'form is visible again');
    assert.ok(dom.resultDiv.classList.contains('hidden'), 'result is hidden');
    assert.equal(dom.resultDiv.innerHTML, '', 'result is cleared');
    assert.equal(dom.spanEl.textContent, 'Drag & drop or click to choose a file', 'drop label restored');
  });

  it('sends Authorization header when the token field is filled', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.tokenInput.value = 's3cret';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = ctx.getLastFetch();
    assert.equal(opts.headers['Authorization'], 'Bearer s3cret');
  });

  it('sends no Authorization header when the token field is empty', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = ctx.getLastFetch();
    assert.equal(opts.headers['Authorization'], undefined);
  });

  it('includes expiry in upload request', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.expirySelect.value = '30m';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url] = ctx.getLastFetch();
    assert.ok(url.includes('expires=30m'));
  });
});

describe('upload.html template', () => {
  it('file input does not have required attribute', () => {
    const html = readFileSync(new URL('./upload.html', import.meta.url), 'utf8');
    // The file input should not be required so drag-and-drop works
    assert.ok(!html.match(/<input[^>]*type="file"[^>]*required/),
      'file input must not have required attribute');
  });

  it('has drop-zone element', () => {
    const html = readFileSync(new URL('./upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="drop-zone"'));
  });

  it('has upload form', () => {
    const html = readFileSync(new URL('./upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="upload-form"'));
  });

  it('keeps the CLI quickstart docs and drops the Raw downloads blurb', () => {
    const html = readFileSync(new URL('./upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('CLI quickstart'), 'CLI quickstart should remain');
    assert.ok(!html.includes('Raw downloads'), 'Raw downloads section should be removed');
  });
});
