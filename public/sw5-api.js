(function () {
  const urlInput = document.getElementById("sw5-store-url");
  const userInput = document.getElementById("sw5-user");
  const apiKeyInput = document.getElementById("sw5-apikey");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  // Shopware 5's legacy REST API (/api/*) is protected with HTTP Digest Auth (username +
  // apikey). Returning `digest` instead of `headers` tells ApiTools to run the two-round-trip
  // handshake through /api/proxy-digest (the server computes the Authorization header).
  function digestAuth() {
    return { user: userInput.value.trim() || "doofinder", pass: apiKeyInput.value.trim() };
  }

  const ENDPOINTS = [
    {
      key: "sw5-shops",
      title: "Shops",
      pathLabel: "/api/shops",
      build(base) {
        return { url: `${base}/api/shops`, method: "GET", digest: digestAuth() };
      },
    },
    {
      key: "sw5-products",
      title: "Products",
      pathLabel: "/api/products",
      params: [
        { id: "shopId", label: "shop_id", type: "text" },
        { id: "limit", label: "limit", type: "number", default: 10 },
        { id: "start", label: "start", type: "number", default: 0 },
      ],
      build(base, get) {
        const url = `${base}/api/products?shop_id=${encodeURIComponent(get("shopId"))}&limit=${get("limit") || 10}&start=${get("start") || 0}`;
        return { url, method: "GET", digest: digestAuth() };
      },
    },
    {
      key: "sw5-article",
      title: "Article by ID",
      pathLabel: "/api/articles/{id}",
      params: [{ id: "id", label: "Article ID", type: "text" }],
      build(base, get) {
        return { url: `${base}/api/articles/${encodeURIComponent(get("id"))}`, method: "GET", digest: digestAuth() };
      },
    },
  ];

  ApiTools.mount(document.getElementById("sw5-api-endpoints"), ENDPOINTS, baseUrl);
})();
