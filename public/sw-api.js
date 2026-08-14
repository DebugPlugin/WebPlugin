(function () {
  const urlInput = document.getElementById("sw-store-url");
  const accessKeyInput = document.getElementById("sw-access-key");
  const clientIdInput = document.getElementById("sw-admin-client-id");
  const clientSecretInput = document.getElementById("sw-admin-client-secret");
  const bearerInput = document.getElementById("sw-admin-bearer");
  const salesChannelInput = document.getElementById("sw-sales-channel-id");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  function storefrontHeaders() {
    return {
      "sw-access-key": accessKeyInput.value.trim(),
      "Content-Type": "application/json",
      "Sw-include-seo-urls": "1",
    };
  }

  function adminBearerHeaders() {
    const token = bearerInput.value.trim();
    return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  // Mirrors the plugin's own /store-api/product filter shape — active-only, with the
  // associations the plugin reads (categories, options, properties, cover, manufacturer...).
  function productBody(extraFilters, limit, page) {
    const body = {
      associations: {
        categories: {},
        children: {
          associations: {
            cover: {},
            options: { associations: { group: {} } },
            properties: { associations: { group: {} } },
          },
        },
        cover: {},
        manufacturer: {},
        options: { associations: { group: {} } },
        properties: { associations: { group: {} } },
        tags: {},
      },
      filter: [{ field: "active", type: "equals", value: true }, ...extraFilters],
    };
    if (limit) body.limit = limit;
    if (page) body.page = page;
    return body;
  }

  const ENDPOINTS = [
    {
      key: "sw-products",
      title: "Storefront — Products",
      pathLabel: "/store-api/product",
      params: [
        { id: "limit", label: "limit", type: "number", default: 100 },
        { id: "page", label: "page", type: "number", default: 1 },
      ],
      build(base, get) {
        const body = productBody([{ field: "parentId", type: "equals", value: null }], Number(get("limit")) || 100, Number(get("page")) || 1);
        return { url: `${base}/store-api/product`, method: "POST", headers: storefrontHeaders(), body: JSON.stringify(body) };
      },
    },
    {
      key: "sw-product-number",
      title: "Storefront — Product by productNumber (parent)",
      pathLabel: "/store-api/product",
      params: [{ id: "productNumber", label: "productNumber", type: "text", placeholder: "e.g. SW10001" }],
      build(base, get) {
        const body = productBody([
          { field: "parentId", type: "equals", value: null },
          { field: "productNumber", type: "equals", value: get("productNumber") },
        ]);
        return { url: `${base}/store-api/product`, method: "POST", headers: storefrontHeaders(), body: JSON.stringify(body) };
      },
    },
    {
      key: "sw-variant-number",
      title: "Storefront — Variant by productNumber",
      pathLabel: "/store-api/product",
      params: [{ id: "productNumber", label: "productNumber", type: "text", placeholder: "e.g. SW10001.1" }],
      build(base, get) {
        const body = productBody([{ field: "productNumber", type: "equals", value: get("productNumber") }]);
        return { url: `${base}/store-api/product`, method: "POST", headers: storefrontHeaders(), body: JSON.stringify(body) };
      },
    },
    {
      key: "sw-oauth-token",
      title: "Admin — Get OAuth Token",
      pathLabel: "/api/oauth/token",
      hint: "Response contains access_token — paste it into \"Admin Bearer Token\" above to use the Sales Channel call below.",
      build(base) {
        const body = {
          grant_type: "client_credentials",
          client_id: clientIdInput.value.trim(),
          client_secret: clientSecretInput.value.trim(),
        };
        return { url: `${base}/api/oauth/token`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      },
    },
    {
      key: "sw-sales-channel",
      title: "Admin — Sales Channel by ID",
      pathLabel: "/api/sales-channel/{id}",
      hint: "Response's data.attributes.accessKey is the Storefront API access key — paste it into \"Storefront Access Key\" above.",
      params: [{ id: "id", label: "Sales Channel ID", type: "text" }],
      build(base, get) {
        const qs = [
          "associations[currency][limit]=1",
          "associations[domains][associations][currency][limit]=1",
          "associations[domains][associations][language][associations][locale][limit]=1",
          "associations[domains][associations][language][limit]=1",
          "associations[language][associations][locale][limit]=1",
          "associations[language][limit]=1",
        ].join("&");
        const id = get("id") || salesChannelInput.value.trim();
        return { url: `${base}/api/sales-channel/${encodeURIComponent(id)}?${qs}`, method: "GET", headers: adminBearerHeaders() };
      },
    },
    {
      key: "sw-products-full",
      title: "Storefront — Products (full field set)",
      pathLabel: "/store-api/product",
      hint: "Same call the plugin itself makes — richer includes/associations than the plain \"Products\" call above.",
      params: [
        { id: "limit", label: "limit", type: "number", default: 100 },
        { id: "page", label: "page", type: "number", default: 1 },
      ],
      build(base, get) {
        const body = {
          associations: {
            categories: {},
            children: {
              associations: {
                cover: {},
                options: { associations: { group: {} } },
                properties: { associations: { group: {} } },
              },
              filter: [{ field: "active", type: "equals", value: true }],
              limit: 1,
            },
            cover: {},
            manufacturer: {},
            options: { associations: { group: {} } },
            properties: { associations: { group: {} } },
            tags: {},
          },
          filter: [
            { field: "active", type: "equals", value: true },
            { field: "parentId", type: "equals", value: null },
          ],
          includes: {
            calculated_price: ["unitPrice", "totalPrice", "referencePrice", "listPrice"],
            category: ["id", "name", "breadcrumb"],
            media: ["id", "url"],
            media_thumbnail: ["url", "width", "height"],
            product: [
              "id", "productNumber", "name", "description", "active", "stock", "availableStock",
              "calculatedPrice", "categories", "children", "cover", "customFields", "manufacturer",
              "options", "properties", "seoUrls", "tags", "translated",
            ],
            product_manufacturer: ["name"],
            product_media: ["media"],
            property_group: ["name"],
            property_group_option: ["name"],
            seo_url: ["seoPathInfo"],
          },
          limit: Number(get("limit")) || 100,
          page: Number(get("page")) || 1,
        };
        return { url: `${base}/store-api/product`, method: "POST", headers: storefrontHeaders(), body: JSON.stringify(body) };
      },
    },
  ];

  ApiTools.mount(document.getElementById("sw-api-endpoints"), ENDPOINTS, baseUrl);
})();
