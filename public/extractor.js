window.Extractor = (function () {
  const getters = {};
  const resetters = {};

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function mount(container) {
    container.innerHTML = `
      <div class="card">
        <h2>Import HAR — exact (recommended)</h2>
        <p class="hint">
          In Chrome: open the page → DevTools → <strong>Network</strong> tab → reload →
          right-click the request list → <strong>"Save all as HAR with content"</strong>. Upload that
          file here — it's exactly what the browser really requested, nothing guessed. You can
          select or drop several .har files at once (e.g. from different pages of the same
          site) and they'll be merged into one result.
        </p>
        <p class="privacy-warning">⚠️ A HAR captures real browser traffic — don't import or share one from a session with confidential data you don't want exposed. Redaction below is heuristic, not a guarantee.</p>
        <label class="checkbox-row">
          <input type="checkbox" id="ext-har-redact-checkbox" checked>
          Redact sensitive data in file contents (email, tokens, cards…)
        </label>
        <div class="extractor-dropzone" id="ext-har-dropzone">
          Drag one or more .har files here, or click to choose them
        </div>
        <input type="file" id="ext-har-input" accept=".har,application/json" multiple hidden>
        <ul class="extractor-har-file-list" id="ext-har-file-list"></ul>
        <div class="extractor-panel-actions">
          <button type="button" id="ext-har-btn" class="btn-secondary" disabled>Import</button>
        </div>
      </div>

      <div class="card">
        <h2>Quick URL scan — approximate</h2>
        <p class="hint">
          No browser: plain HTTP requests to the HTML and to each discovered JS/CSS file.
          Doesn't execute code, so it can miss URLs that only exist at runtime (those show up
          separately, marked as not confirmed).
        </p>
        <p class="privacy-warning">⚠️ Only inline HTML content is redacted below — fetched external JS/CSS files are shared and downloaded as-is.</p>
        <label class="checkbox-row">
          <input type="checkbox" id="ext-inline-only-checkbox" checked>
          Inline only (JS/CSS embedded in the HTML) — a HAR already covers the rest
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="ext-redact-checkbox" checked>
          Redact sensitive data in inline content (email, tokens, cards…)
        </label>
        <div class="extractor-kind-filter">
          <label><input type="radio" name="ext-kind-filter" value="all" checked> All (JS + CSS)</label>
          <label><input type="radio" name="ext-kind-filter" value="js"> JS only</label>
          <label><input type="radio" name="ext-kind-filter" value="css"> CSS only</label>
        </div>
        <div class="field-row">
          <label for="ext-url-input">Page URL</label>
          <input type="url" id="ext-url-input" placeholder="https://example.com/article">
        </div>
        <div class="extractor-panel-actions">
          <button type="button" id="ext-scan-btn" class="btn-primary">Scan</button>
        </div>
      </div>

      <div id="ext-status" class="hint"></div>

      <div id="ext-results" hidden>
        <div class="extractor-toolbar">
          <span class="extractor-summary" id="ext-summary-label"></span>
          <div class="extractor-download-group">
            <button class="btn-secondary" id="ext-download-js-btn">Download JS</button>
            <button class="btn-secondary" id="ext-download-css-btn">Download CSS</button>
            <button class="btn-primary" id="ext-download-all-btn">Download all</button>
          </div>
        </div>

        <section class="extractor-kind-section">
          <h3>JavaScript <span class="extractor-count-pill" id="ext-js-count-pill">0</span></h3>
          <p class="hint" style="margin-bottom:6px;">Only files with sensitive data redacted are listed here.</p>
          <ul class="extractor-file-list" id="ext-js-list-ok"></ul>
          <div class="hint" id="ext-js-empty" hidden></div>
          <details id="ext-js-failed-wrap" hidden>
            <summary id="ext-js-failed-summary"></summary>
            <ul class="extractor-file-list" id="ext-js-list-failed"></ul>
          </details>
        </section>

        <section class="extractor-kind-section">
          <h3>CSS <span class="extractor-count-pill" id="ext-css-count-pill">0</span></h3>
          <p class="hint" style="margin-bottom:6px;">Only files with sensitive data redacted are listed here.</p>
          <ul class="extractor-file-list" id="ext-css-list-ok"></ul>
          <div class="hint" id="ext-css-empty" hidden></div>
          <details id="ext-css-failed-wrap" hidden>
            <summary id="ext-css-failed-summary"></summary>
            <ul class="extractor-file-list" id="ext-css-list-failed"></ul>
          </details>
        </section>
      </div>

      <p class="hint">
        Only scan/import URLs you're authorized to inspect. In scan mode, some sites with
        anti-bot protection may still block the initial request — this tool doesn't try to
        evade such protections.
      </p>
    `;

    const statusEl = container.querySelector('#ext-status');
    const results = container.querySelector('#ext-results');
    const summaryLabel = container.querySelector('#ext-summary-label');

    const harDropzone = container.querySelector('#ext-har-dropzone');
    const harInput = container.querySelector('#ext-har-input');
    const harFileList = container.querySelector('#ext-har-file-list');
    const harBtn = container.querySelector('#ext-har-btn');
    const harRedactCheckbox = container.querySelector('#ext-har-redact-checkbox');

    const urlInput = container.querySelector('#ext-url-input');
    const scanBtn = container.querySelector('#ext-scan-btn');
    const inlineOnlyCheckbox = container.querySelector('#ext-inline-only-checkbox');
    const redactCheckbox = container.querySelector('#ext-redact-checkbox');

    const downloadJsBtn = container.querySelector('#ext-download-js-btn');
    const downloadCssBtn = container.querySelector('#ext-download-css-btn');
    const downloadAllBtn = container.querySelector('#ext-download-all-btn');

    const jsListOk = container.querySelector('#ext-js-list-ok');
    const jsListFailed = container.querySelector('#ext-js-list-failed');
    const jsFailedWrap = container.querySelector('#ext-js-failed-wrap');
    const jsFailedSummary = container.querySelector('#ext-js-failed-summary');
    const jsCountPill = container.querySelector('#ext-js-count-pill');
    const jsEmpty = container.querySelector('#ext-js-empty');

    const cssListOk = container.querySelector('#ext-css-list-ok');
    const cssListFailed = container.querySelector('#ext-css-list-failed');
    const cssFailedWrap = container.querySelector('#ext-css-failed-wrap');
    const cssFailedSummary = container.querySelector('#ext-css-failed-summary');
    const cssCountPill = container.querySelector('#ext-css-count-pill');
    const cssEmpty = container.querySelector('#ext-css-empty');

    // The last scan/import result (token + file metadata, no bodies) — what
    // "Include extracted JS/CSS" shares with MCP via the platform page's
    // Share with Claude button.
    let lastResult = null;

    function getKindFilter() {
      const checked = container.querySelector('input[name="ext-kind-filter"]:checked');
      return checked ? checked.value : 'all';
    }

    function setStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.style.color = isError ? 'var(--error, #ffb4b4)' : '';
    }

    function makeItem(f) {
      const li = document.createElement('li');
      if (!f.ok) li.className = 'failed';
      const urlSpan = document.createElement('span');
      urlSpan.className = 'url';
      urlSpan.textContent = f.url;
      const via = document.createElement('span');
      via.className = 'via';
      via.textContent = f.foundVia + (f.error ? ` — ${f.error}` : '');
      urlSpan.appendChild(via);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = f.ok ? fmtSize(f.size) : '';
      li.appendChild(urlSpan);
      li.appendChild(meta);
      return li;
    }

    function fillSection(files, listOk, listFailed, failedWrap, failedSummary, countPill, emptyNote, extLabel) {
      listOk.innerHTML = '';
      listFailed.innerHTML = '';
      const ok = files.filter((f) => f.ok);
      const failed = files.filter((f) => !f.ok);
      const redacted = ok.filter((f) => (f.redactedCount || 0) > 0);
      redacted.forEach((f) => listOk.appendChild(makeItem(f)));
      failed.forEach((f) => listFailed.appendChild(makeItem(f)));
      countPill.textContent = ok.length;
      if (redacted.length) {
        emptyNote.hidden = true;
      } else {
        emptyNote.hidden = false;
        emptyNote.textContent = ok.length
          ? `${ok.length} ${extLabel} downloaded, none with sensitive data redacted.`
          : `No ${extLabel} confirmed.`;
      }
      if (failed.length) {
        failedWrap.hidden = false;
        failedSummary.textContent = `${failed.length} not confirmed — hidden by default`;
      } else {
        failedWrap.hidden = true;
      }
      return { okCount: ok.length };
    }

    function renderResults(data) {
      const jsFiles = data.files.filter((f) => f.kind === 'js');
      const cssFiles = data.files.filter((f) => f.kind === 'css');

      const { okCount: okJs } = fillSection(jsFiles, jsListOk, jsListFailed, jsFailedWrap, jsFailedSummary, jsCountPill, jsEmpty, '.js');
      const { okCount: okCss } = fillSection(cssFiles, cssListOk, cssListFailed, cssFailedWrap, cssFailedSummary, cssCountPill, cssEmpty, '.css');

      downloadJsBtn.disabled = !okJs;
      downloadCssBtn.disabled = !okCss;
      downloadAllBtn.disabled = !okJs && !okCss;

      summaryLabel.textContent = `${okJs} JS confirmed · ${okCss} CSS confirmed (of ${data.count} detected) on ${data.pageUrl}`;
      results.hidden = false;
    }

    function download(kind) {
      if (!lastResult) return;
      const q = kind === 'all' ? '' : `?kind=${kind}`;
      window.location.href = `/api/extractor/download/${lastResult.token}${q}`;
    }
    downloadJsBtn.addEventListener('click', () => download('js'));
    downloadCssBtn.addEventListener('click', () => download('css'));
    downloadAllBtn.addEventListener('click', () => download('all'));

    // ---- HAR file selection: click-to-browse, drag & drop, per-file removal ----
    let harFiles = [];

    function renderHarFileList() {
      harFileList.innerHTML = '';
      harFiles.forEach((file, i) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'chip-name';
        name.textContent = file.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-file';
        remove.textContent = '✕';
        remove.title = 'Remove this file';
        remove.addEventListener('click', () => {
          harFiles.splice(i, 1);
          renderHarFileList();
        });
        li.appendChild(name);
        li.appendChild(remove);
        harFileList.appendChild(li);
      });
      harBtn.disabled = harFiles.length === 0;
    }

    function addHarFiles(fileList) {
      Array.from(fileList || []).forEach((file) => {
        const isDup = harFiles.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
        if (!isDup) harFiles.push(file);
      });
      renderHarFileList();
    }

    harDropzone.addEventListener('click', () => harInput.click());
    harInput.addEventListener('change', () => {
      addHarFiles(harInput.files);
      harInput.value = '';
    });
    harDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      harDropzone.classList.add('drag');
    });
    harDropzone.addEventListener('dragleave', () => harDropzone.classList.remove('drag'));
    harDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      harDropzone.classList.remove('drag');
      addHarFiles(e.dataTransfer.files);
    });

    harBtn.addEventListener('click', async () => {
      if (!harFiles.length) return;

      harBtn.disabled = true;
      results.hidden = true;
      lastResult = null;
      setStatus(harFiles.length > 1 ? `Importing ${harFiles.length} HAR files…` : 'Importing HAR…');

      try {
        const fd = new FormData();
        harFiles.forEach((file) => fd.append('har', file));
        fd.append('redact', harRedactCheckbox.checked ? 'true' : 'false');
        const res = await fetch('/api/extractor/import-har', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unknown error');

        lastResult = data;
        renderResults(data);
        setStatus(harFiles.length > 1 ? `${harFiles.length} HAR files imported and merged.` : 'HAR imported successfully.');
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        harBtn.disabled = harFiles.length === 0;
      }
    });

    scanBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) return;

      scanBtn.disabled = true;
      results.hidden = true;
      lastResult = null;
      setStatus('Scanning… this can take a few seconds if there are many files.');

      try {
        const res = await fetch('/api/extractor/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            inlineOnly: inlineOnlyCheckbox.checked,
            kind: getKindFilter(),
            redact: redactCheckbox.checked,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unknown error');

        lastResult = data;
        renderResults(data);
        setStatus('Scan complete.');
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        scanBtn.disabled = false;
      }
    });

    getters[container.id] = () => lastResult;

    resetters[container.id] = () => {
      harFiles = [];
      renderHarFileList();
      harRedactCheckbox.checked = true;
      urlInput.value = '';
      inlineOnlyCheckbox.checked = true;
      redactCheckbox.checked = true;
      container.querySelector('input[name="ext-kind-filter"][value="all"]').checked = true;
      results.hidden = true;
      lastResult = null;
      setStatus('');
    };
  }

  function getLastResult(containerId) {
    return getters[containerId] ? getters[containerId]() : null;
  }

  function resetAll(containerId) {
    if (resetters[containerId]) resetters[containerId]();
  }

  return { mount, getLastResult, resetAll };
})();
