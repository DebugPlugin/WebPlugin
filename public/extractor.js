window.Extractor = (function () {
  const runners = {};
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
        <h2>Import HAR — exact</h2>
        <p class="hint">
          In Chrome: open the page → DevTools → <strong>Network</strong> tab → reload →
          right-click the request list → <strong>"Save all as HAR with content"</strong>. Upload that
          file here — it's exactly what the browser really requested, nothing guessed, including
          inline &lt;script&gt;/&lt;style&gt; content. You can select or drop several .har files at
          once (e.g. from different pages of the same site) and they'll be merged into one result.
        </p>
        <p class="hint">
          Tip: for a large capture, filter the Network tab to <strong>JS</strong>/<strong>CSS</strong>
          before exporting — Chrome's "Save all as HAR" only exports the currently filtered rows,
          which keeps the file well under this server's per-file upload limit. Oversized files are
          also split into smaller parts automatically.
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
        <p class="error-banner" id="ext-har-error" hidden></p>
        <p class="hint">Files here are imported automatically when you click "Share with MCP" below.</p>
      </div>

      <div id="ext-status" class="hint"></div>

      <div id="ext-results" hidden>
        <section class="extractor-kind-section">
          <h3>JavaScript <span class="extractor-count-pill" id="ext-js-count-pill">0</span></h3>
          <div class="hint" id="ext-js-empty" hidden></div>
          <details id="ext-js-ok-wrap" hidden>
            <summary id="ext-js-ok-summary"></summary>
            <p class="hint" style="margin:6px 0;">Only files with sensitive data redacted are listed here.</p>
            <ul class="extractor-file-list" id="ext-js-list-ok"></ul>
          </details>
          <details id="ext-js-failed-wrap" hidden>
            <summary id="ext-js-failed-summary"></summary>
            <ul class="extractor-file-list" id="ext-js-list-failed"></ul>
          </details>
        </section>

        <section class="extractor-kind-section">
          <h3>CSS <span class="extractor-count-pill" id="ext-css-count-pill">0</span></h3>
          <div class="hint" id="ext-css-empty" hidden></div>
          <details id="ext-css-ok-wrap" hidden>
            <summary id="ext-css-ok-summary"></summary>
            <p class="hint" style="margin:6px 0;">Only files with sensitive data redacted are listed here.</p>
            <ul class="extractor-file-list" id="ext-css-list-ok"></ul>
          </details>
          <details id="ext-css-failed-wrap" hidden>
            <summary id="ext-css-failed-summary"></summary>
            <ul class="extractor-file-list" id="ext-css-list-failed"></ul>
          </details>
        </section>
      </div>

      <p class="hint">Only import a HAR from a session you're authorized to inspect.</p>
    `;

    const statusEl = container.querySelector('#ext-status');
    const results = container.querySelector('#ext-results');

    const harDropzone = container.querySelector('#ext-har-dropzone');
    const harInput = container.querySelector('#ext-har-input');
    const harFileList = container.querySelector('#ext-har-file-list');
    const harErrorEl = container.querySelector('#ext-har-error');
    const harRedactCheckbox = container.querySelector('#ext-har-redact-checkbox');

    const jsListOk = container.querySelector('#ext-js-list-ok');
    const jsOkWrap = container.querySelector('#ext-js-ok-wrap');
    const jsOkSummary = container.querySelector('#ext-js-ok-summary');
    const jsListFailed = container.querySelector('#ext-js-list-failed');
    const jsFailedWrap = container.querySelector('#ext-js-failed-wrap');
    const jsFailedSummary = container.querySelector('#ext-js-failed-summary');
    const jsCountPill = container.querySelector('#ext-js-count-pill');
    const jsEmpty = container.querySelector('#ext-js-empty');

    const cssListOk = container.querySelector('#ext-css-list-ok');
    const cssOkWrap = container.querySelector('#ext-css-ok-wrap');
    const cssOkSummary = container.querySelector('#ext-css-ok-summary');
    const cssListFailed = container.querySelector('#ext-css-list-failed');
    const cssFailedWrap = container.querySelector('#ext-css-failed-wrap');
    const cssFailedSummary = container.querySelector('#ext-css-failed-summary');
    const cssCountPill = container.querySelector('#ext-css-count-pill');
    const cssEmpty = container.querySelector('#ext-css-empty');

    // The last import result (token + file metadata, no bodies) — what
    // "Include extracted JS/CSS" shares with MCP via the platform page's
    // Share with Claude button, which triggers the import itself (see
    // runners[container.id] below) instead of a dedicated Import button.
    let lastResult = null;

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

    function fillSection(files, listOk, okWrap, okSummary, listFailed, failedWrap, failedSummary, countPill, emptyNote, extLabel) {
      listOk.innerHTML = '';
      listFailed.innerHTML = '';
      const ok = files.filter((f) => f.ok);
      const failed = files.filter((f) => !f.ok);
      const redacted = ok.filter((f) => (f.redactedCount || 0) > 0);
      redacted.forEach((f) => listOk.appendChild(makeItem(f)));
      failed.forEach((f) => listFailed.appendChild(makeItem(f)));
      countPill.textContent = ok.length;
      if (redacted.length) {
        okWrap.hidden = false;
        okSummary.textContent = `${redacted.length} file(s) with sensitive data redacted`;
        emptyNote.hidden = true;
      } else {
        okWrap.hidden = true;
        emptyNote.hidden = false;
        emptyNote.textContent = ok.length
          ? `${ok.length} ${extLabel} confirmed, none with sensitive data redacted.`
          : `No ${extLabel} confirmed.`;
      }
      if (failed.length) {
        failedWrap.hidden = false;
        failedSummary.textContent = `${failed.length} not confirmed — hidden by default`;
      } else {
        failedWrap.hidden = true;
      }
    }

    function renderResults(data) {
      const jsFiles = data.files.filter((f) => f.kind === 'js');
      const cssFiles = data.files.filter((f) => f.kind === 'css');

      fillSection(jsFiles, jsListOk, jsOkWrap, jsOkSummary, jsListFailed, jsFailedWrap, jsFailedSummary, jsCountPill, jsEmpty, '.js');
      fillSection(cssFiles, cssListOk, cssOkWrap, cssOkSummary, cssListFailed, cssFailedWrap, cssFailedSummary, cssCountPill, cssEmpty, '.css');

      results.hidden = false;
    }

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

    // ---- Import, run automatically by "Share with MCP" (see run() below) ----

    // A HAR file this big almost always exceeds this host's per-request upload limit
    // on its own — split it into several smaller synthetic HAR files (each a subset
    // of the original's log.entries) instead of letting the whole import fail.
    const MAX_PART_BYTES = 4 * 1024 * 1024;

    async function splitIfNeeded(file) {
      if (file.size <= MAX_PART_BYTES) return [file];

      let har;
      try {
        har = JSON.parse(await file.text());
      } catch {
        return [file]; // not valid JSON — let the server report that clearly
      }
      const entries = har?.log?.entries;
      if (!Array.isArray(entries) || entries.length < 2) return [file];

      const parts = [];
      let current = [];
      let currentSize = 40; // rough overhead for the {"log":{"version":"...","entries":[]}} wrapper
      for (const entry of entries) {
        const entrySize = JSON.stringify(entry).length + 1;
        if (current.length && currentSize + entrySize > MAX_PART_BYTES) {
          parts.push(current);
          current = [];
          currentSize = 40;
        }
        current.push(entry);
        currentSize += entrySize;
      }
      if (current.length) parts.push(current);
      if (parts.length <= 1) return [file];

      const baseName = file.name.replace(/\.har$/i, '');
      return parts.map(
        (partEntries, i) =>
          new File(
            [JSON.stringify({ log: { version: har.log?.version || '1.2', entries: partEntries } })],
            `${baseName}.part${i + 1}of${parts.length}.har`,
            { type: 'application/json' }
          )
      );
    }

    async function runHarImport() {
      results.hidden = true;
      lastResult = null;
      harErrorEl.hidden = true;
      let token = null;

      try {
        setStatus('Preparing files…');
        const parts = [];
        for (const file of harFiles) {
          parts.push(...(await splitIfNeeded(file)));
        }

        // One HAR per request, chained by token, instead of bundling them into a
        // single upload — a combined multi-file body can exceed this host's request
        // size limit even when each file individually would fit.
        for (let i = 0; i < parts.length; i++) {
          const file = parts[i];
          setStatus(parts.length > 1 ? `Importing ${i + 1}/${parts.length}: ${file.name}…` : 'Importing HAR…');

          const fd = new FormData();
          fd.append('har', file);
          fd.append('redact', harRedactCheckbox.checked ? 'true' : 'false');
          if (token) fd.append('token', token);

          const res = await fetch('/api/extractor/import-har', { method: 'POST', body: fd });
          let data;
          try {
            data = await res.json();
          } catch {
            harErrorEl.textContent = `"${file.name}" is too large to import automatically, even after splitting. Upload it directly in the chat with Claude instead.`;
            harErrorEl.hidden = false;
            throw new Error('Import failed — see the message above.');
          }
          if (!res.ok) throw new Error(data.error || 'Unknown error');

          token = data.token;
          lastResult = data;
          renderResults(data);
        }
        setStatus(parts.length > 1 ? `${parts.length} part(s) imported and merged.` : 'HAR imported successfully.');
        return lastResult;
      } catch (err) {
        setStatus(err.message, true);
        return null;
      }
    }

    runners[container.id] = async () => {
      if (harFiles.length) return runHarImport();
      setStatus('Nothing to import yet — add a .har file above.');
      return null;
    };

    resetters[container.id] = () => {
      harFiles = [];
      renderHarFileList();
      harRedactCheckbox.checked = true;
      harErrorEl.hidden = true;
      results.hidden = true;
      lastResult = null;
      setStatus('');
    };
  }

  // Runs the staged HAR import and returns its result — called by the platform
  // page's "Share with MCP" button instead of a dedicated Import button here.
  function run(containerId) {
    return runners[containerId] ? runners[containerId]() : Promise.resolve(null);
  }

  function resetAll(containerId) {
    if (resetters[containerId]) resetters[containerId]();
  }

  return { mount, run, resetAll };
})();
