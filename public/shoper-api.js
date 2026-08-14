(function () {
  const urlInput = document.getElementById("shoper-store-url");
  const tokenInput = document.getElementById("shoper-token");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  function bearerHeaders() {
    const token = tokenInput.value.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const ENDPOINTS = [
    {
      key: "shoper-product",
      title: "Product by ID",
      pathLabel: "/webapi/rest/products/{id}",
      params: [{ id: "id", label: "Product ID", type: "text" }],
      build(base, get) {
        return { url: `${base}/webapi/rest/products/${encodeURIComponent(get("id"))}`, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "shoper-catalog",
      title: "Catalog",
      pathLabel: "/webapi/rest/products",
      params: [
        { id: "page", label: "page", type: "number", default: 1 },
        { id: "limit", label: "limit", type: "number", default: 100 },
      ],
      build(base, get) {
        const url = `${base}/webapi/rest/products?page=${get("page") || 1}&limit=${get("limit") || 100}`;
        return { url, method: "GET", headers: bearerHeaders() };
      },
    },
  ];

  ApiTools.mount(document.getElementById("shoper-api-endpoints"), ENDPOINTS, baseUrl);
})();
