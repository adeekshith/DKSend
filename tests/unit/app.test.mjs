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
  const textInput = new MockElement('textarea', { id: 'text-input' });

  const submitBtn = new MockElement('button', { id: 'submit-btn', type: 'submit' });
  submitBtn.textContent = 'Upload';
  const uploadForm = new MockElement('form', { id: 'upload-form' });
  uploadForm.dataset.mode = 'file';
  uploadForm.children.push(submitBtn);
  const resultDiv = new MockElement('div', { id: 'result' });

  const elements = { 'upload-form': uploadForm, file: fileInput, 'drop-zone': dropZone, filename: filenameInput, expiry: expirySelect, token: tokenInput, 'text-input': textInput, result: resultDiv };

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

  return { document, uploadForm, fileInput, dropZone, filenameInput, expirySelect, tokenInput, textInput, resultDiv, spanEl, submitBtn };
}

const SUCCESS_JSON = {
  success: true,
  code: 'abc',
  filename: 'test.txt',
  size_bytes: 100,
  download_page_url: 'http://localhost/abc',
  raw_download_url: 'http://localhost/raw/abc/test.txt',
  sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  delete_token: 'tok123tok123tok123tok123tok12312',
  delete_url: 'http://localhost/delete/abc?token=tok123tok123tok123tok123tok12312',
};

// Mirrors the subset of XMLHttpRequest that app.js uses. Auto-responds on a
// microtask unless opts.manual, in which case tests drive
// instances[i].upload.onprogress(...) and instances[i].respond(...).
function makeFakeXhrClass(getResponse, manual) {
  const instances = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.requestHeaders = {};
      instances.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key, value) {
      this.requestHeaders[key] = value;
    }
    send(body) {
      this.body = body;
      if (!manual) {
        queueMicrotask(() => this.respond());
      }
    }
    respond(reply) {
      const r = reply || getResponse();
      this.status = r.status ?? 200;
      // r.raw simulates a non-JSON reply (e.g. a reverse proxy error page)
      this.responseText = r.raw !== undefined ? r.raw : JSON.stringify(r.json);
      this.onload?.();
    }
    fail() {
      this.onerror?.();
    }
  }
  FakeXHR.instances = instances;
  return FakeXHR;
}

function loadApp(dom, opts = {}) {
  const { document } = dom;
  // Inject globals and evaluate app.js
  const code = readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
  const wrapped = new Function('document', 'navigator', 'fetch', 'setTimeout', 'window', 'XMLHttpRequest', code);
  const responses = opts.responses ? [...opts.responses] : [];
  const getResponse = () => (responses.length ? responses.shift() : { status: 200, json: SUCCESS_JSON });
  const FakeXHR = makeFakeXhrClass(getResponse, !!opts.manual);
  const fakeNav = { clipboard: { writeText: async () => {} } };
  wrapped(document, fakeNav, undefined, (fn) => fn(), opts.window || {}, FakeXHR);
  return {
    instances: FakeXHR.instances,
    getLastFetch: () => {
      const last = FakeXHR.instances[FakeXHR.instances.length - 1];
      if (!last || last.body === undefined) {
        return null;
      }
      return [last.url, { method: last.method, body: last.body, headers: last.requestHeaders }];
    },
  };
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

  it('reads max file size from the data-max-file-size attribute', async () => {
    const dom2 = makeDom();
    dom2.uploadForm.dataset.maxFileSize = '1024';
    const ctx2 = loadApp(dom2);
    const file = { name: 'small-but-over.bin', size: 2048 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx2.getLastFetch(), null, 'upload must be blocked by the injected limit');
    assert.ok(dom2.resultDiv.innerHTML.includes('too large'));
    assert.ok(dom2.resultDiv.innerHTML.includes('1.0 KB'), 'limit should be human-formatted');
  });

  it('falls back to 200 MB when the attribute is missing', async () => {
    const okFile = { name: 'ok.bin', size: 199 * 1024 * 1024 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [okFile] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(ctx.getLastFetch(), null, '199 MB should pass the default limit');
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

  it('shows a progress bar while uploading', async () => {
    const dom2 = makeDom();
    const ctx2 = loadApp(dom2, { manual: true });
    const file = { name: 'big.bin', size: 1024 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('<progress'), 'progress element shown during upload');
    assert.ok(dom2.resultDiv.innerHTML.includes('big.bin'));

    ctx2.instances[0].respond();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('Uploaded'), 'result panel replaces progress');
  });

  it('updates transferred bytes on progress events', async () => {
    const dom2 = makeDom();
    const ctx2 = loadApp(dom2, { manual: true });
    const file = { name: 'big.bin', size: 1024 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));

    ctx2.instances[0].upload.onprogress({ lengthComputable: true, loaded: 512, total: 1024 });
    assert.ok(dom2.resultDiv.innerHTML.includes('50%'), 'percentage reflects progress');
    assert.ok(dom2.resultDiv.innerHTML.includes('512 B / 1.0 KB'), 'transferred/total shown');

    ctx2.instances[0].respond();
  });

  it('shows the server error message when the response is not success', async () => {
    const dom2 = makeDom();
    loadApp(dom2, {
      responses: [
        { status: 413, json: { success: false, error: { message: 'File exceeds the configured size limit.' } } },
      ],
    });
    const file = { name: 'big.bin', size: 1024 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('File exceeds the configured size limit.'));
    assert.ok(!dom2.uploadForm.classList.contains('hidden'), 'form stays visible on failure');
  });

  it('shows "Unexpected server response" when the reply is not JSON', async () => {
    // What a reverse proxy's auth middleware produces when it intercepts
    // the request: its own HTML error page instead of DKSend's JSON
    const dom2 = makeDom();
    loadApp(dom2, {
      responses: [{ status: 401, raw: '<html><body>401 Unauthorized</body></html>' }],
    });
    const file = { name: 'f.txt', size: 10 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('Unexpected server response'));
    assert.ok(!dom2.uploadForm.classList.contains('hidden'), 'form stays visible');
  });

  it('shows a network error message when the request fails', async () => {
    const dom2 = makeDom();
    const ctx2 = loadApp(dom2, { manual: true });
    const file = { name: 'f.txt', size: 10 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    ctx2.instances[0].fail();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('Network error'));
  });

  it('embeds a QR code for the download page url in the result block', async () => {
    const dom2 = makeDom();
    let receivedText = null;
    const fakeQrcode = () => ({
      addData(text) { receivedText = text; },
      make() {},
      createSvgTag: () => '<svg data-fake-qr="1"></svg>',
    });
    loadApp(dom2, { window: { qrcode: fakeQrcode } });
    const file = { name: 'doc.pdf', size: 2048 };
    dom2.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom2.resultDiv.innerHTML.includes('qr-block'));
    assert.ok(dom2.resultDiv.innerHTML.includes('data-fake-qr'));
    assert.equal(receivedText, 'http://localhost/abc', 'QR encodes the download page url');
  });

  it('renders an empty QR block when the qr library is missing', async () => {
    const file = { name: 'doc.pdf', size: 2048 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(dom.resultDiv.innerHTML.includes('class="qr-block"'), 'block present');
    assert.ok(!dom.resultDiv.innerHTML.includes('<svg'), 'no svg without the library');
  });

  it('sends the X-Upload-Token header when the token field is filled', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.tokenInput.value = 's3cret';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = ctx.getLastFetch();
    // Not Authorization: reverse-proxy auth middleware intercepts that
    assert.equal(opts.headers['X-Upload-Token'], 's3cret');
    assert.equal(opts.headers['Authorization'], undefined);
  });

  it('sends no token header when the token field is empty', async () => {
    const file = { name: 'f.txt', size: 10 };
    dom.dropZone.dispatchEvent(
      makeEvent('drop', { dataTransfer: { files: [file] } }),
    );
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = ctx.getLastFetch();
    assert.equal(opts.headers['X-Upload-Token'], undefined);
  });

  function dispatchPaste(targetDom, files, spy = {}) {
    const event = {
      type: 'paste',
      clipboardData: { files },
      preventDefault() { spy.prevented = true; },
    };
    for (const handler of targetDom.document._listeners.paste || []) {
      handler(event);
    }
    return spy;
  }

  it('pasting a file selects it and updates the drop label', () => {
    const file = { name: 'ignored.png', size: 100, type: 'image/png' };
    dispatchPaste(dom, [file]);
    assert.ok(dom.spanEl.textContent.startsWith('pasted-'), `label is ${dom.spanEl.textContent}`);
    assert.ok(dom.spanEl.textContent.endsWith('.png'));
  });

  // Pasting a file while in text mode used to update selectedFiles and the
  // hidden drop label, then submit ignored it because dataset.mode was 'text'.
  it('pasting a file while in text mode switches back to file mode', () => {
    dom.uploadForm.dataset.mode = 'text';
    const file = { name: 'shot.png', size: 100, type: 'image/png' };
    dispatchPaste(dom, [file]);
    assert.equal(dom.uploadForm.dataset.mode, 'file', 'a pasted file must not be ignored');
    assert.ok(dom.spanEl.textContent.startsWith('pasted-'));
  });

  it('pasted image upload uses a generated mime-derived filename', async () => {
    const file = { name: 'ignored.png', size: 100, type: 'image/png' };
    dispatchPaste(dom, [file]);
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url] = ctx.getLastFetch();
    assert.ok(url.includes('name=pasted-'), `url is ${url}`);
    assert.ok(url.includes('.png'));
  });

  it('text paste does not steal the selection', () => {
    const spy = dispatchPaste(dom, [], {});
    assert.notEqual(spy.prevented, true, 'preventDefault must not run for text pastes');
    assert.equal(dom.spanEl.textContent, 'Drag & drop or click to choose a file');
  });

  it('selecting multiple files updates the label to a count', () => {
    dom.fileInput.files = [
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    assert.equal(dom.spanEl.textContent, '2 files selected');
  });

  it('disables the filename override for multiple files and re-enables for one', () => {
    dom.fileInput.files = [
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    assert.equal(dom.filenameInput.disabled, true);

    dom.fileInput.files = [{ name: 'solo.txt', size: 10 }];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    assert.equal(dom.filenameInput.disabled, false);
  });

  it('uploads multiple files sequentially', async () => {
    const dom2 = makeDom();
    const ctx2 = loadApp(dom2, { manual: true });
    dom2.fileInput.files = [
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ];
    dom2.fileInput.dispatchEvent(makeEvent('change'));
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(ctx2.instances.length, 1, 'second upload must wait for the first');
    assert.ok(ctx2.instances[0].url.includes('name=a.txt'));

    ctx2.instances[0].respond();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx2.instances.length, 2, 'second upload starts after the first finishes');
    assert.ok(ctx2.instances[1].url.includes('name=b.txt'));

    ctx2.instances[1].respond();
    await new Promise((r) => setTimeout(r, 10));
    const cards = dom2.resultDiv.innerHTML.match(/class="file-card"/g) || [];
    assert.equal(cards.length, 2, 'one card per file');
    assert.ok(dom2.resultDiv.innerHTML.includes('<h3>Uploaded</h3>'));
  });

  it('applies the filename override only to a single file', async () => {
    const dom2 = makeDom();
    const ctx2 = loadApp(dom2, { manual: true });
    dom2.filenameInput.value = 'custom.txt';
    dom2.fileInput.files = [
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ];
    dom2.fileInput.dispatchEvent(makeEvent('change'));
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(ctx2.instances[0].url.includes('name=a.txt'), 'per-file name kept for batches');
    assert.ok(!ctx2.instances[0].url.includes('custom.txt'));
    ctx2.instances[0].respond();
  });

  it('continues after a per-file failure and renders an error card', async () => {
    const dom2 = makeDom();
    loadApp(dom2, {
      responses: [
        { status: 413, json: { success: false, error: { message: 'too big' } } },
        { status: 201, json: SUCCESS_JSON },
      ],
    });
    dom2.fileInput.files = [
      { name: 'fails.bin', size: 10 },
      { name: 'works.txt', size: 10 },
    ];
    dom2.fileInput.dispatchEvent(makeEvent('change'));
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const html = dom2.resultDiv.innerHTML;
    assert.ok(html.includes('file-card-error'), 'failed file gets an error card');
    assert.ok(html.includes('too big'));
    assert.ok(html.includes('Open download page'), 'successful file still gets its card');
    assert.ok(dom2.uploadForm.classList.contains('hidden'), 'form hides when at least one succeeded');
  });

  it('keeps the form visible when every file fails', async () => {
    const dom2 = makeDom();
    loadApp(dom2, {
      responses: [
        { status: 413, json: { success: false, error: { message: 'too big' } } },
        { status: 413, json: { success: false, error: { message: 'too big' } } },
      ],
    });
    dom2.fileInput.files = [
      { name: 'a.bin', size: 10 },
      { name: 'b.bin', size: 10 },
    ];
    dom2.fileInput.dispatchEvent(makeEvent('change'));
    dom2.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!dom2.uploadForm.classList.contains('hidden'));
    assert.ok(!dom2.resultDiv.innerHTML.includes('<h3>Uploaded</h3>'));
  });

  it('shares typed text in text mode with the default name', async () => {
    dom.uploadForm.dataset.mode = 'text';
    dom.textInput.value = 'hello shared note';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url, opts] = ctx.getLastFetch();
    assert.ok(url.includes('name=note.txt'), `url was ${url}`);
    assert.equal(opts.method, 'PUT');
    assert.ok(opts.body, 'a body blob should be sent');
  });

  it('honors the filename override in text mode', async () => {
    dom.uploadForm.dataset.mode = 'text';
    dom.textInput.value = 'config contents';
    dom.filenameInput.value = 'config.yaml';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    const [url] = ctx.getLastFetch();
    assert.ok(url.includes('name=config.yaml'), `url was ${url}`);
  });

  it('does not submit empty text in text mode', async () => {
    dom.uploadForm.dataset.mode = 'text';
    dom.textInput.value = '   \n  ';
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.getLastFetch(), null, 'whitespace-only text must not upload');
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
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    // The file input should not be required so drag-and-drop works
    assert.ok(!html.match(/<input[^>]*type="file"[^>]*required/),
      'file input must not have required attribute');
  });

  it('has drop-zone element', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="drop-zone"'));
  });

  it('has upload form', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="upload-form"'));
  });

  it('keeps the CLI quickstart docs and drops the Raw downloads blurb', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('CLI quickstart'), 'CLI quickstart should remain');
    assert.ok(!html.includes('Raw downloads'), 'Raw downloads section should be removed');
  });

  it('injects expiry options from the server', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(
      /\{%\s*for choice in expiry_choices\s*%\}/.test(html),
      'expiry options come from server config',
    );
    assert.ok(!html.includes('value="30m"'), 'no hardcoded expiry options');
  });

  it('exposes the configured max file size on the form', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(/data-max-file-size="\{\{\s*max_file_size\s*\}\}"/.test(html));
  });

  it('file input allows multiple files', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(/<input[^>]*type="file"[^>]*multiple/.test(html));
  });

  it('has a File/Text mode toggle and a text input, defaulting to file', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(html.includes('data-mode="file"'), 'form defaults to file mode');
    assert.ok(html.includes('data-mode-set="text"'), 'text tab present');
    assert.ok(html.includes('id="text-input"'), 'textarea present');
  });

  it('loads the QR library before app.js', () => {
    const html = readFileSync(new URL('../../templates/upload.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('/static/qr.js') !== -1);
    assert.ok(html.indexOf('/static/qr.js') < html.indexOf('/static/app.js'));
  });

  it('download page has a QR placeholder and the QR library', () => {
    const html = readFileSync(new URL('../../templates/download.html', import.meta.url), 'utf8');
    assert.ok(/data-qr="\{\{\s*download_page_url\s*\}\}"/.test(html));
    assert.ok(html.indexOf('/static/qr.js') !== -1);
    assert.ok(html.indexOf('/static/qr.js') < html.indexOf('/static/app.js'));
  });
});

describe('interpolated values are escaped', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>.txt';

  it('a hostile filename is escaped in the result card', async () => {
    const dom = makeDom();
    loadApp(dom, {
      responses: [{ status: 200, json: { ...SUCCESS_JSON, filename: HOSTILE } }],
    });
    dom.fileInput.files = [{ name: HOSTILE, size: 10 }];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));

    const html = dom.resultDiv.innerHTML;
    assert.ok(!html.includes('<img src=x'), `raw markup must not reach the DOM: ${html}`);
    assert.ok(html.includes('&lt;img src=x'), 'the name should still be shown, escaped');
  });

  it('a hostile filename is escaped in an error card', async () => {
    const dom = makeDom();
    loadApp(dom, {
      responses: [{ status: 500, json: { success: false, error: { message: '<b>boom</b>' } } }],
    });
    dom.fileInput.files = [{ name: HOSTILE, size: 10 }];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));

    const html = dom.resultDiv.innerHTML;
    assert.ok(!html.includes('<img src=x'), 'filename must be escaped');
    assert.ok(!html.includes('<b>boom</b>'), 'the server message must be escaped too');
    assert.ok(html.includes('&lt;b&gt;boom'), 'and still be readable');
  });

  it('a quote in a filename cannot break out of an attribute', async () => {
    const dom = makeDom();
    const nasty = 'a" onmouseover="alert(1)';
    loadApp(dom, {
      responses: [
        { status: 200, json: { ...SUCCESS_JSON, download_page_url: `http://x/${nasty}` } },
      ],
    });
    dom.fileInput.files = [{ name: 'q.txt', size: 10 }];
    dom.fileInput.dispatchEvent(makeEvent('change'));
    dom.uploadForm.dispatchEvent(makeEvent('submit'));
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(
      !dom.resultDiv.innerHTML.includes('onmouseover="'),
      'a bare quote must not terminate the attribute',
    );
  });
});
