(function () {
  const container = document.getElementById('mcp-overview');
  if (!container) return;

  const PLATFORMS = [
    { key: 'prestashop', label: 'PrestaShop' },
    { key: 'magento', label: 'Magento' },
    { key: 'woocommerce', label: 'WooCommerce' },
    { key: 'shopware', label: 'Shopware' },
    { key: 'shopware5', label: 'Shopware 5' },
    { key: 'shoper', label: 'Shoper' },
    { key: 'shopify', label: 'Shopify' },
    { key: 'bigcommerce', label: 'BigCommerce' },
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

  async function load() {
    container.innerHTML = '<p class="hint">Loading...</p>';
    const results = await Promise.all(PLATFORMS.map(loadOne));

    const rows = results
      .map(({ key, label, ctx }) => {
        if (!ctx || !ctx.savedAt) {
          return `<tr><td>${escapeHtml(label)}</td><td colspan="5" style="color: var(--text-faint);">Nothing shared yet.</td></tr>`;
        }
        const version = ctx.includeCode ? escapeHtml(ctx.selectedVersion || '—') : 'not shared';
        const apiCall = ctx.apiCall
          ? `${escapeHtml(ctx.apiCall.method)} ${escapeHtml(ctx.apiCall.url)} <span style="color: var(--text-muted);">(HTTP ${escapeHtml(ctx.apiCall.status)})</span>`
          : '—';
        const screenshots = ctx.screenshotCount || 0;
        const notes = ctx.notes ? 'Yes' : 'No';
        const savedAt = escapeHtml(new Date(ctx.savedAt).toLocaleString());
        return `<tr>
          <td>${escapeHtml(label)}</td>
          <td>${version}</td>
          <td>${apiCall}</td>
          <td>${screenshots}</td>
          <td>${notes}</td>
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
              <th>Shared at</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  load();
})();
