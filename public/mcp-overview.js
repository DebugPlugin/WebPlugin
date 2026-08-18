(function () {
  const container = document.getElementById('mcp-overview');
  if (!container) return;

  const toggleBtn = document.getElementById('mcp-overview-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleBtn.classList.toggle('open');
      document.getElementById(toggleBtn.dataset.target).classList.toggle('open');
    });
  }

  const PLATFORMS = [
    { key: 'prestashop', label: 'PrestaShop' },
    { key: 'magento', label: 'Magento' },
    { key: 'woocommerce', label: 'WooCommerce' },
    { key: 'shopware', label: 'Shopware' },
    { key: 'shopware5', label: 'Shopware 5' },
    { key: 'shoper', label: 'Shoper' },
    { key: 'shopify', label: 'Shopify' },
    { key: 'bigcommerce', label: 'BigCommerce' },
    { key: 'others', label: 'Others' },
  ];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function loadOne(platform) {
    try {
      const res = await fetch(`/api/${platform.key}/context`);
      const ctx = await res.json();
      return { ...platform, ctx };
    } catch {
      return { ...platform, ctx: null };
    }
  }

  async function loadUsage() {
    try {
      const usage = await fetch('/api/redis-usage').then((r) => r.json());
      if (!usage.available) return '';
      const usedMb = (usage.usedBytes / (1024 * 1024)).toFixed(2);
      const limitMb = (usage.limitBytes / (1024 * 1024)).toFixed(0);
      const freeMb = ((usage.limitBytes - usage.usedBytes) / (1024 * 1024)).toFixed(2);
      return `<p class="hint" style="margin-top: 12px; margin-bottom: 0;">Storage: ${usedMb} MB used of ${limitMb} MB (${freeMb} MB free)</p>`;
    } catch {
      return '';
    }
  }

  async function load() {
    container.innerHTML = '<p class="hint">Loading...</p>';
    const [results, usageHtml] = await Promise.all([Promise.all(PLATFORMS.map(loadOne)), loadUsage()]);

    const rows = results
      .map(({ key, label, ctx }) => {
        if (!ctx || !ctx.savedAt) {
          return `<tr><td>${escapeHtml(label)}</td><td colspan="6" style="color: var(--text-faint);">Nothing shared yet.</td></tr>`;
        }
        const version = ctx.includeCode ? escapeHtml(ctx.selectedVersion || '—') : 'not shared';
        const apiCall = ctx.apiCall
          ? `${escapeHtml(ctx.apiCall.method)} ${escapeHtml(ctx.apiCall.url)} <span style="color: var(--text-muted);">(HTTP ${escapeHtml(ctx.apiCall.status)})</span>`
          : '—';
        const screenshots = ctx.screenshotCount || 0;
        const notes = ctx.notes ? 'Yes' : 'No';
        const extracted = ctx.extractedAssetsCount || 0;
        const savedAt = escapeHtml(new Date(ctx.savedAt).toLocaleString());
        return `<tr>
          <td>${escapeHtml(label)}</td>
          <td>${version}</td>
          <td>${apiCall}</td>
          <td>${screenshots}</td>
          <td>${notes}</td>
          <td>${extracted}</td>
          <td>${savedAt}</td>
        </tr>`;
      })
      .join('');

    container.innerHTML = `
      <div style="overflow-x: auto;">
        <table class="mcp-overview-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Version</th>
              <th>Last API call</th>
              <th>Screenshots</th>
              <th>Notes</th>
              <th>JS/CSS</th>
              <th>Shared at</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${usageHtml}`;
  }

  load();
})();
