(function () {
  const urlInput = document.getElementById("wc-store-url");
  const tokenInput = document.getElementById("wc-df-token");
  const userInput = document.getElementById("wc-api-user");
  const passInput = document.getElementById("wc-api-pass");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  function wcAuthHeaders() {
    return { Authorization: ApiTools.basicAuth(userInput.value.trim(), passInput.value.trim()) };
  }

  // Deliberately excludes "users", "comments" etc. — this tool is meant for catalog/content
  // debugging, not for browsing endpoints that can return personal data.
  const SAFE_CONTENT_TYPES = ["posts", "pages", "product", "media", "product_cat", "product_tag"];

  const ENDPOINTS = [
    {
      key: "wc-product",
      title: "Plugin API — Product",
      pathLabel: "/?rest_route=/doofinder/v1/product",
      params: [
        { id: "lang", label: "lang", type: "text" },
        { id: "page", label: "page", type: "number", default: 1 },
        { id: "per_page", label: "per_page", type: "number", default: 100 },
      ],
      build(base, get) {
        const url = `${base}/?rest_route=%2Fdoofinder%2Fv1%2Fproduct&lang=${encodeURIComponent(get("lang"))}&per_page=${get("per_page") || 100}&page=${get("page") || 1}&status=publish`;
        const token = tokenInput.value.trim();
        return { url, method: "GET", headers: token ? { "Doofinder-Token": token } : {} };
      },
    },
    {
      key: "wc-catalogue",
      title: "Original REST API — Catalogue",
      pathLabel: "/?rest_route=/wc/v3/products",
      params: [
        { id: "page", label: "page", type: "number", default: 1 },
        { id: "per_page", label: "per_page", type: "number", default: 30 },
      ],
      build(base, get) {
        const url = `${base}/?rest_route=%2Fwc%2Fv3%2Fproducts&page=${get("page") || 1}&_embed=null&per_page=${get("per_page") || 30}&status=publish`;
        return { url, method: "GET", headers: wcAuthHeaders() };
      },
    },
    {
      key: "wc-sku",
      title: "Original REST API — Product by SKU/ID",
      pathLabel: "/?rest_route=/wc/v3/products/{sku}",
      params: [{ id: "sku", label: "SKU / ID", type: "text", placeholder: "e.g. 123" }],
      build(base, get) {
        const url = `${base}/?rest_route=%2Fwc%2Fv3%2Fproducts%2F${encodeURIComponent(get("sku"))}`;
        return { url, method: "GET", headers: wcAuthHeaders() };
      },
    },
    {
      key: "wc-attr",
      title: "Original REST API — Attributes",
      pathLabel: "/?rest_route=/wc/v3/products/attributes",
      build(base) {
        const url = `${base}/?rest_route=%2Fwc%2Fv3%2Fproducts%2Fattributes`;
        return { url, method: "GET", headers: wcAuthHeaders() };
      },
    },
    {
      key: "wc-content",
      title: "Original REST API — Content",
      pathLabel: "/?rest_route=/wp/v2/{entry}",
      params: [
        { id: "entry", label: "entry", type: "select", options: SAFE_CONTENT_TYPES, default: "posts" },
        { id: "page", label: "page", type: "number", default: 1 },
        { id: "per_page", label: "per_page", type: "number", default: 30 },
      ],
      build(base, get) {
        const url = `${base}/?rest_route=%2Fwp%2Fv2%2F${encodeURIComponent(get("entry"))}&page=${get("page") || 1}&_embed=null&per_page=${get("per_page") || 30}&status=publish`;
        return { url, method: "GET", headers: {} };
      },
    },
    {
      key: "wc-content-id",
      title: "Original REST API — Content by ID",
      pathLabel: "/?rest_route=/wp/v2/{entry}/{id}",
      params: [
        { id: "entry", label: "entry", type: "select", options: SAFE_CONTENT_TYPES, default: "posts" },
        { id: "id", label: "ID", type: "text", placeholder: "e.g. 42" },
      ],
      build(base, get) {
        const url = `${base}/?rest_route=%2Fwp%2Fv2%2F${encodeURIComponent(get("entry"))}%2F${encodeURIComponent(get("id"))}`;
        return { url, method: "GET", headers: {} };
      },
    },
  ];

  ApiTools.mount(document.getElementById("wc-api-endpoints"), ENDPOINTS, baseUrl);
})();
