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

  function refreshStatusForSelection() {
    const release = releases.find(r => r.tag === versionSelect.value);
    if (release && release.downloaded) {
      setDownloadStatus('ok', 'Downloaded');
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
  const includeApiCheckbox = document.getElementById('chat-include-api');
  const includeScreenshotsCheckbox = document.getElementById('chat-include-screenshots');

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

    if (includeApiCheckbox && includeApiCheckbox.checked && window.ApiTools) {
      const last = ApiTools.getLastResponse();
      if (last) {
        const headerLines = Object.entries(last.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
        blocks.push({
          type: 'text',
          text: `[Context: response from "${last.title}"]\n${last.method} ${last.url}\n${headerLines}\nHTTP ${last.status}\n\`\`\`json\n${last.json}\n\`\`\``
        });
        hasExtraContext = true;
      }
      includeApiCheckbox.checked = false;
    }

    if (includeScreenshotsCheckbox && includeScreenshotsCheckbox.checked && window.Screenshots) {
      const images = Screenshots.getAll(includeScreenshotsCheckbox.dataset.storageKey);
      images.forEach((img) => {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      });
      if (images.length) hasExtraContext = true;
      includeScreenshotsCheckbox.checked = false;
    }

    blocks.push({ type: 'text', text: message });
    const outgoingContent = hasExtraContext ? blocks : message;
    chatHistory.push({ role: 'user', content: outgoingContent });

    const pendingBody = appendChatMessage('assistant', '...');

    try {
      const res = await fetch(`/api/${PLATFORM}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory })
      });
      const data = await res.json();
      if (data.error) {
        pendingBody.textContent = 'Error: ' + data.error;
      } else {
        pendingBody.textContent = data.reply;
        chatHistory.push({ role: 'assistant', content: data.reply });
      }
    } catch (err) {
      pendingBody.textContent = 'Network error: ' + err.message;
    } finally {
      chatInput.disabled = false;
      chatInput.focus();
    }
  });
})();
