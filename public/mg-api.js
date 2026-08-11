(function () {
  const urlInput = document.getElementById("mg-store-url");
  const storeCodeInput = document.getElementById("mg-store-code");
  const tokenInput = document.getElementById("mg-bearer-token");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  function storeCode() {
    return storeCodeInput.value.trim() || "default";
  }

  function bearerHeaders() {
    const token = tokenInput.value.trim();
    return { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  const ENDPOINTS = [
    {
      key: "mg-storeconfigs",
      title: "Store Configs",
      pathLabel: "/rest/V1/store/storeConfigs",
      build(base) {
        return { url: `${base}/rest/V1/store/storeConfigs`, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "mg-config",
      title: "Doofinder Config",
      pathLabel: "/rest/{store_code}/V1/doofinder/config",
      build(base) {
        return { url: `${base}/rest/${storeCode()}/V1/doofinder/config`, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "mg-products",
      title: "Products",
      pathLabel: "/rest/{store_code}/V1/custom/products",
      params: [
        { id: "page", label: "currentPage", type: "number", default: 1 },
        { id: "size", label: "pageSize", type: "number", default: 100 },
      ],
      build(base, get) {
        const page = get("page") || 1;
        const size = get("size") || 100;
        const url = `${base}/rest/${storeCode()}/V1/custom/products?searchCriteria[filter_groups][0][filters][0][field]=status&searchCriteria[filter_groups][0][filters][0][value]=1&searchCriteria[filter_groups][0][filters][0][condition_type]=eq&searchCriteria[filter_groups][1][filters][0][field]=visibility&searchCriteria[filter_groups][1][filters][0][condition_type]=gt&searchCriteria[filter_groups][1][filters][0][value]=2&searchCriteria[pageSize]=${size}&searchCriteria[currentPage]=${page}`;
        return { url, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "mg-sku",
      title: "Product by SKU",
      pathLabel: "/rest/{store_code}/V1/custom/products/{sku}",
      params: [{ id: "sku", label: "SKU", type: "text", placeholder: "e.g. MH01-XS-Black" }],
      build(base, get) {
        const sku = encodeURIComponent(get("sku"));
        const url = `${base}/rest/${storeCode()}/V1/custom/products/${sku}?searchCriteria[filter_groups][0][filters][0][field]=status&searchCriteria[filter_groups][0][filters][0][value]=1&searchCriteria[filter_groups][0][filters][0][condition_type]=eq&searchCriteria[filter_groups][1][filters][0][field]=visibility&searchCriteria[filter_groups][1][filters][0][condition_type]=gt&searchCriteria[filter_groups][1][filters][0][value]=2&searchCriteria[pageSize]=1`;
        return { url, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "mg-attr",
      title: "Attributes",
      pathLabel: "/rest/{store_code}/V1/products/attributes",
      params: [
        { id: "page", label: "current_page", type: "number", default: 1 },
        { id: "size", label: "pageSize", type: "number", default: 100 },
      ],
      build(base, get) {
        const page = get("page") || 1;
        const size = get("size") || 100;
        const url = `${base}/rest/${storeCode()}/V1/products/attributes?searchCriteria[current_page]=${page}&searchCriteria[filter_groups][0][filters][0][field]=is_visible&searchCriteria[filter_groups][0][filters][0][value]=1&searchCriteria[filter_groups][1][filters][0][field]=is_required&searchCriteria[filter_groups][1][filters][0][value]=0&searchCriteria[pageSize]=${size}`;
        return { url, method: "GET", headers: bearerHeaders() };
      },
    },
    {
      key: "mg-categories",
      title: "Categories",
      pathLabel: "/rest/{store_code}/V1/categories/list",
      params: [
        { id: "page", label: "current_page", type: "number", default: 1 },
        { id: "size", label: "pageSize", type: "number", default: 100 },
      ],
      build(base, get) {
        const page = get("page") || 1;
        const size = get("size") || 100;
        const url = `${base}/rest/${storeCode()}/V1/categories/list?searchCriteria[current_page]=${page}&searchCriteria[filter_groups][0][filters][0][conditionType]=gt&searchCriteria[filter_groups][0][filters][0][field]=entity_id&searchCriteria[filter_groups][0][filters][0][value]=1&searchCriteria[filter_groups][1][filters][0][conditionType]=gt&searchCriteria[filter_groups][1][filters][0][field]=parent_id&searchCriteria[filter_groups][1][filters][0][value]=1&searchCriteria[pageSize]=${size}`;
        return { url, method: "GET", headers: bearerHeaders() };
      },
    },
  ];

  ApiTools.mount(document.getElementById("mg-api-endpoints"), ENDPOINTS, baseUrl);
})();
