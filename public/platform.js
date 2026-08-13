(function () {
  const PLATFORM = window.PLATFORM;

  const versionSelect = document.getElementById('version-select');
  const btnDownload = document.getElementById('btn-download');
  const downloadStatus = document.getElementById('download-status');
  let releases = [];

  function setDownloadStatus(kind, text) {
    downloadStatus.className = 'status-badge ' + kind;
    downloadStatus.textContent = text;
    downloadStatus.classList.remove('hidden');
  }

  const DOWNLOADED_KEY = `doopresta-downloaded-${PLATFORM}`;

  function getLocallyDownloaded() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function markLocallyDownloaded(tag) {
    const set = getLocallyDownloaded();
    set.add(tag);
    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...set]));
  }

  function refreshStatusForSelection() {
    const release = releases.find(r => r.tag === versionSelect.value);
    const locallyDownloaded = getLocallyDownloaded().has(versionSelect.value);
    if (release && release.downloaded) {
      setDownloadStatus('ok', 'Downloaded');
    } else if (locallyDownloaded) {
      setDownloadStatus('ok', 'Already downloaded before (cached in this browser — no need to re-download)');
    } else {
      downloadStatus.classList.add('hidden');
    }
  }

  async function loadReleases() {
    const res = await fetch(`/api/${PLATFORM}/releases`);
    releases = await res.json();
    versionSelect.innerHTML = '';
    releases.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.tag;
      opt.textContent = r.name ? `${r.tag} — ${r.name}` : r.tag;
      versionSelect.appendChild(opt);
    });
    refreshStatusForSelection();
  }

  versionSelect.addEventListener('change', refreshStatusForSelection);

  btnDownload.addEventListener('click', async () => {
    const tag = versionSelect.value;
    if (!tag) return;
    btnDownload.disabled = true;
    setDownloadStatus('pending', 'Downloading...');
    try {
      const res = await fetch(`/api/${PLATFORM}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag })
      });
      const data = await res.json();
      if (data.error) {
        setDownloadStatus('err', data.error);
      } else {
        const release = releases.find(r => r.tag === tag);
        if (release) release.downloaded = true;
        markLocallyDownloaded(tag);
        setDownloadStatus('ok', 'Downloaded');
      }
    } catch (err) {
      setDownloadStatus('err', err.message);
    } finally {
      btnDownload.disabled = false;
    }
  });

  loadReleases();

  // ---------- Chat ----------

  const chatHistory = [];
  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const includeApiCallCheckbox = document.getElementById('chat-include-api-call');
  const includeApiJsonCheckbox = document.getElementById('chat-include-api-json');
  const includeScreenshotsCheckbox = document.getElementById('chat-include-screenshots');
  const chatModelSelect = document.getElementById('chat-model-select');
  const chatHeading = document.getElementById('chat-heading');

  const MODEL_LABELS = {
    'claude-opus-5': 'Claude Opus 5',
    'claude-sonnet-5': 'Claude Sonnet 5',
  };

  function updateChatHeading() {
    if (!chatHeading || !chatModelSelect) return;
    chatHeading.textContent = `Chat with ${MODEL_LABELS[chatModelSelect.value] || chatModelSelect.value}`;
  }

  if (chatModelSelect) {
    chatModelSelect.addEventListener('change', updateChatHeading);
    updateChatHeading();
  }

  // ---------- Share API call / screenshots with MCP ----------
  // Pushes the current data to the server so the MCP tools get_last_api_call and
  // get_screenshots (used by e.g. Claude Desktop) can read it. Shared per platform,
  // not private — see NOTA in chat about this.
  const shareMcpButton = document.getElementById('chat-share-mcp');
  if (shareMcpButton) {
    shareMcpButton.addEventListener('click', async () => {
      const payload = { selectedVersion: versionSelect.value };

      if (window.ApiTools) {
        const last = ApiTools.getLastResponse();
        if (last) payload.apiCall = last;
      }

      if (includeScreenshotsCheckbox && window.Screenshots) {
        const images = Screenshots.getAll(includeScreenshotsCheckbox.dataset.storageKey);
        if (images.length) payload.screenshots = images;
      }

      const originalLabel = shareMcpButton.textContent;
      try {
        const res = await fetch(`/api/${PLATFORM}/context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        shareMcpButton.textContent = data.error ? '⚠️ Error' : '✅ Shared!';
        if (!data.error) refreshSharedStatus();
      } catch (err) {
        shareMcpButton.textContent = '⚠️ Error';
      }
      setTimeout(() => { shareMcpButton.textContent = originalLabel; }, 1600);
    });
  }

  // ---------- "Shared with MCP" status panel ----------

  const sharedStatusBox = document.getElementById('shared-mcp-status');
  const sharedResetBtn = document.getElementById('shared-mcp-reset');

  async function refreshSharedStatus() {
    if (!sharedStatusBox) return;
    try {
      const res = await fetch(`/api/${PLATFORM}/context`);
      const ctx = await res.json();
      if (!ctx.savedAt) {
        sharedStatusBox.textContent = 'Nothing shared yet.';
        return;
      }
      sharedStatusBox.textContent = [
        `Shared at: ${new Date(ctx.savedAt).toLocaleString()}`,
        `Selected version: ${ctx.selectedVersion || '—'}`,
        `API call: ${ctx.apiCall ? `${ctx.apiCall.method} ${ctx.apiCall.url} (HTTP ${ctx.apiCall.status})` : '—'}`,
        `Screenshots: ${ctx.screenshotCount}`
      ].join('\n');
    } catch (err) {
      sharedStatusBox.textContent = 'Could not load status: ' + err.message;
    }
  }

  if (sharedResetBtn) {
    sharedResetBtn.addEventListener('click', async () => {
      sharedResetBtn.disabled = true;
      try {
        await fetch(`/api/${PLATFORM}/context/reset`, { method: 'POST' });
        await refreshSharedStatus();
      } finally {
        sharedResetBtn.disabled = false;
      }
    });
  }

  refreshSharedStatus();

  function appendChatMessage(role, text) {
    const row = document.createElement('div');
    row.className = 'chat-message ' + role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Claude';
    const body = document.createElement('div');
    body.textContent = text;
    row.appendChild(who);
    row.appendChild(body);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return body;
  }

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    chatInput.value = '';
    chatInput.disabled = true;

    appendChatMessage('user', message);

    const blocks = [];
    let hasExtraContext = false;

    const wantsApiCall = includeApiCallCheckbox && includeApiCallCheckbox.checked;
    const wantsApiJson = includeApiJsonCheckbox && includeApiJsonCheckbox.checked;

    if ((wantsApiCall || wantsApiJson) && window.ApiTools) {
      const last = ApiTools.getLastResponse();
      if (last) {
        if (wantsApiCall) {
          const headerLines = Object.entries(last.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
          blocks.push({
            type: 'text',
            text: `[Context: API call made — "${last.title}"]\n${last.method} ${last.url}\n${headerLines}`
          });
          hasExtraContext = true;
        }
        if (wantsApiJson) {
          blocks.push({
            type: 'text',
            text: `[Context: API response from "${last.title}", HTTP ${last.status}]\n\`\`\`json\n${last.json}\n\`\`\``
          });
          hasExtraContext = true;
        }
      }
    }

    if (includeScreenshotsCheckbox && includeScreenshotsCheckbox.checked && window.Screenshots) {
      const images = Screenshots.getAll(includeScreenshotsCheckbox.dataset.storageKey);
      images.forEach((img) => {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      });
      if (images.length) hasExtraContext = true;
    }

    blocks.push({ type: 'text', text: message });
    const outgoingContent = hasExtraContext ? blocks : message;
    chatHistory.push({ role: 'user', content: outgoingContent });

    const pendingBody = appendChatMessage('assistant', '');
    pendingBody.classList.add('thinking');
    let dots = 0;
    pendingBody.textContent = 'Claude is thinking';
    const thinkingTimer = setInterval(() => {
      dots = (dots + 1) % 4;
      pendingBody.textContent = 'Claude is thinking' + '.'.repeat(dots);
    }, 400);

    try {
      const res = await fetch(`/api/${PLATFORM}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: chatHistory,
          version: versionSelect.value,
          model: chatModelSelect ? chatModelSelect.value : undefined
        })
      });
      const data = await res.json();
      clearInterval(thinkingTimer);
      pendingBody.classList.remove('thinking');
      if (data.error) {
        pendingBody.textContent = 'Error: ' + data.error;
      } else {
        pendingBody.textContent = data.reply;
        chatHistory.push({ role: 'assistant', content: data.reply });
      }
    } catch (err) {
      clearInterval(thinkingTimer);
      pendingBody.classList.remove('thinking');
      pendingBody.textContent = 'Network error: ' + err.message;
    } finally {
      chatInput.disabled = false;
      chatInput.focus();
    }
  });
})();
