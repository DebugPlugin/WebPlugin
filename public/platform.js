(function () {
  const PLATFORM = window.PLATFORM;

  const versionSelect = document.getElementById('version-select');

  async function loadReleases() {
    if (!versionSelect) return; // platforms with no browsable plugin source skip this entirely
    const res = await fetch(`/api/${PLATFORM}/releases`);
    const releases = await res.json();
    versionSelect.innerHTML = '';
    releases.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.tag;
      opt.textContent = r.name ? `${r.tag} — ${r.name}` : r.tag;
      versionSelect.appendChild(opt);
    });
  }

  loadReleases();

  // ---------- Reset local data (Notes / Screenshots / API call history / JS/CSS Extractor) ----------

  const resetLocalBtn = document.getElementById('btn-reset-local');
  if (resetLocalBtn) {
    resetLocalBtn.addEventListener('click', () => {
      const wantNotes = document.getElementById('reset-notes')?.checked;
      const wantScreenshots = document.getElementById('reset-screenshots')?.checked;
      const wantApi = document.getElementById('reset-api')?.checked;
      const wantExtractor = document.getElementById('reset-extractor')?.checked;
      const screenshotsCheckbox = document.getElementById('chat-include-screenshots');
      const extractorResetCheckbox = document.getElementById('reset-extractor');

      if (wantNotes && window.Notes) window.Notes.resetAll();
      if (wantScreenshots && window.Screenshots && screenshotsCheckbox) {
        window.Screenshots.resetAll(screenshotsCheckbox.dataset.storageKey);
      }
      if (wantApi && window.ApiTools) window.ApiTools.reset();
      if (wantExtractor && window.Extractor && extractorResetCheckbox) {
        window.Extractor.resetAll(extractorResetCheckbox.dataset.storageKey);
      }

      const originalLabel = resetLocalBtn.textContent;
      resetLocalBtn.textContent = '✅ Reset!';
      setTimeout(() => { resetLocalBtn.textContent = originalLabel; }, 1400);
    });
  }

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
      const originalLabel = shareMcpButton.textContent;
      shareMcpButton.disabled = true;
      try {
        const tag = versionSelect ? versionSelect.value : '';
        if (tag) {
          shareMcpButton.textContent = '⬇️ Downloading...';
          const dlRes = await fetch(`/api/${PLATFORM}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag })
          });
          const dlData = await dlRes.json();
          if (dlData.error) throw new Error(dlData.error);
        }

        shareMcpButton.textContent = 'Sharing...';
        const includeCodeCheckbox = document.getElementById('chat-include-code');
        const payload = { selectedVersion: tag, includeCode: includeCodeCheckbox ? includeCodeCheckbox.checked : false };

        const wantsApiCall = (includeApiCallCheckbox && includeApiCallCheckbox.checked) || (includeApiJsonCheckbox && includeApiJsonCheckbox.checked);
        if (wantsApiCall && window.ApiTools) {
          const last = ApiTools.getLastResponse();
          if (last) payload.apiCall = last;
        }

        if (includeScreenshotsCheckbox && includeScreenshotsCheckbox.checked && window.Screenshots) {
          const images = Screenshots.getAll(includeScreenshotsCheckbox.dataset.storageKey);
          if (images.length) payload.screenshots = images;
        }

        const includeNotesCheckbox = document.getElementById('chat-include-notes');
        if (includeNotesCheckbox && includeNotesCheckbox.checked && window.Notes) {
          const text = Notes.getText(includeNotesCheckbox.dataset.storageKey);
          if (text) payload.notes = text;
        }

        const includeExtractorCheckbox = document.getElementById('chat-include-extractor');
        if (includeExtractorCheckbox && includeExtractorCheckbox.checked && window.Extractor) {
          const extracted = Extractor.getLastResult(includeExtractorCheckbox.dataset.storageKey);
          if (extracted) payload.extractedAssets = extracted;
        }

        const res = await fetch(`/api/${PLATFORM}/context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        shareMcpButton.textContent = data.error ? '⚠️ Error' : '✅ Downloaded & Shared!';
        if (!data.error) refreshSharedStatus();
      } catch (err) {
        shareMcpButton.textContent = '⚠️ Error';
      } finally {
        setTimeout(() => { shareMcpButton.textContent = originalLabel; shareMcpButton.disabled = false; }, 1800);
      }
    });
  }

  // ---------- "Shared with MCP" status panel ----------

  const sharedStatusBox = document.getElementById('shared-mcp-status');
  const sharedResetBtn = document.getElementById('shared-mcp-reset');

  async function refreshSharedStatus() {
    if (!sharedStatusBox) return;
    try {
      const [ctx, usage] = await Promise.all([
        fetch(`/api/${PLATFORM}/context`).then(r => r.json()),
        fetch('/api/redis-usage').then(r => r.json()).catch(() => ({ available: false }))
      ]);

      const lines = ctx.savedAt
        ? [
            `Shared at: ${new Date(ctx.savedAt).toLocaleString()}`,
            `Selected version: ${ctx.includeCode ? (ctx.selectedVersion || '—') : 'not shared'}`,
            `API call: ${ctx.apiCall ? `${ctx.apiCall.method} ${ctx.apiCall.url} (HTTP ${ctx.apiCall.status})` : '—'}`,
            `Screenshots: ${ctx.screenshotCount}`,
            `Notes: ${ctx.notes ? 1 : 0}`,
            `Extracted JS/CSS: ${ctx.extractedAssetsCount || 0}`
          ]
        : ['Nothing shared yet.'];

      if (usage.available) {
        const usedMb = (usage.usedBytes / (1024 * 1024)).toFixed(2);
        const limitMb = (usage.limitBytes / (1024 * 1024)).toFixed(0);
        const freeMb = ((usage.limitBytes - usage.usedBytes) / (1024 * 1024)).toFixed(2);
        lines.push('', `Redis storage: ${usedMb} MB used of ${limitMb} MB (${freeMb} MB free)`);
      }

      sharedStatusBox.textContent = lines.join('\n');
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

  // Platforms with no browsable plugin source (e.g. Shopware, Shopify) skip the whole Chat
  // section — there's nothing for it to inspect.
  if (chatForm) {
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    chatInput.value = '';
    chatInput.disabled = true;

    appendChatMessage('user', message);
    chatHistory.push({ role: 'user', content: message });

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
          version: versionSelect ? versionSelect.value : undefined,
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
  }
})();
