(function () {
  const urlInput = document.getElementById("shopify-store-url");
  const tokenInput = document.getElementById("shopify-token");
  const apiVersionInput = document.getElementById("shopify-api-version");

  function baseUrl() {
    const u = ApiTools.normalizeUrl(urlInput.value);
    return u ? `https://${u}` : "";
  }

  function apiVersion() {
    return apiVersionInput.value.trim() || "2025-10";
  }

  function graphqlHeaders() {
    return { "X-Shopify-Access-Token": tokenInput.value.trim(), "Content-Type": "application/json" };
  }

  function graphqlUrl(base) {
    return `${base}/admin/api/${apiVersion()}/graphql.json`;
  }

  function gidFromInput(raw) {
    raw = (raw || "").trim();
    if (!raw) return "";
    return raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
  }

  const ENDPOINTS = [
    {
      key: "shopify-title",
      title: "Product by Title",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [{ id: "title", label: "title", type: "text" }],
      build(base, get) {
        const title = get("title").replace(/'/g, "\\'");
        const query = `{ products(first: 5, query: "title:'${title}'") { edges { node { id title handle status vendor productType tags } } } }`;
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
    {
      key: "shopify-gid",
      title: "Product by GID",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [{ id: "gid", label: "GID or numeric ID", type: "text", placeholder: "gid://shopify/Product/123 or 123" }],
      build(base, get) {
        const gid = gidFromInput(get("gid"));
        const query = `{ product(id: "${gid}") { id title handle status vendor productType tags createdAt updatedAt } }`;
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
    {
      key: "shopify-shop",
      title: "Shop, Markets & Languages",
      pathLabel: "/admin/api/{version}/graphql.json",
      build(base) {
        const query =
          "{ shop { name myshopifyDomain primaryDomain { url } currencyCode ianaTimezone } shopLocales { locale name primary published } " +
          "markets(first: 10) { edges { node { id name enabled webPresence { rootUrls { url locale } } } } } }";
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
    {
      key: "shopify-catalog",
      title: "Catalog (cursor pagination)",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [
        { id: "first", label: "first", type: "number", default: 50 },
        { id: "cursor", label: "cursor (optional)", type: "text" },
      ],
      build(base, get) {
        const query =
          "query($cursor: String) { products(first: " + (get("first") || 50) + ", after: $cursor) " +
          "{ pageInfo { hasNextPage endCursor } edges { cursor node { id title handle status } } } }";
        const variables = { cursor: get("cursor") || null };
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query, variables }) };
      },
    },
    {
      key: "shopify-metadefs",
      title: "Metafield Definitions",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [{ id: "ownerType", label: "ownerType", type: "text", default: "PRODUCT" }],
      build(base, get) {
        const ownerType = get("ownerType") || "PRODUCT";
        const query = `{ metafieldDefinitions(first: 50, ownerType: ${ownerType}) { edges { node { id name namespace key type { name } description } } } }`;
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
    {
      key: "shopify-metavalues",
      title: "Metafields on all products (paginated)",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [
        { id: "first", label: "first", type: "number", default: 20 },
        { id: "cursor", label: "cursor (optional)", type: "text" },
      ],
      build(base, get) {
        const query =
          "query($cursor: String) { products(first: " + (get("first") || 20) + ", after: $cursor) { pageInfo { hasNextPage endCursor } " +
          "edges { node { id title metafields(first: 20) { edges { node { namespace key value type } } } } } } }";
        const variables = { cursor: get("cursor") || null };
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query, variables }) };
      },
    },
    {
      key: "shopify-options",
      title: "Attributes/Options on all products (paginated)",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [
        { id: "first", label: "first", type: "number", default: 20 },
        { id: "cursor", label: "cursor (optional)", type: "text" },
      ],
      build(base, get) {
        const query =
          "query($cursor: String) { products(first: " + (get("first") || 20) + ", after: $cursor) { pageInfo { hasNextPage endCursor } " +
          "edges { node { id title options { name values } } } } }";
        const variables = { cursor: get("cursor") || null };
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query, variables }) };
      },
    },
    {
      key: "shopify-collections",
      title: "Collections",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [{ id: "first", label: "first", type: "number", default: 20 }],
      build(base, get) {
        const query = `{ collections(first: ${get("first") || 20}) { edges { node { id title handle productsCount { count } } } } }`;
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
    {
      key: "shopify-blogs",
      title: "Blogs & Articles",
      pathLabel: "/admin/api/{version}/graphql.json",
      params: [
        { id: "blogsFirst", label: "blogs first", type: "number", default: 10 },
        { id: "articlesFirst", label: "articles first", type: "number", default: 10 },
      ],
      build(base, get) {
        const query =
          `{ blogs(first: ${get("blogsFirst") || 10}) { edges { node { id title handle articles(first: ${get("articlesFirst") || 10}) ` +
          "{ edges { node { id title handle publishedAt author { name } tags } } } } } } }";
        return { url: graphqlUrl(base), method: "POST", headers: graphqlHeaders(), body: JSON.stringify({ query }) };
      },
    },
  ];

  ApiTools.mount(document.getElementById("shopify-api-endpoints"), ENDPOINTS, baseUrl);
})();
