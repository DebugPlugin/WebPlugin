(function () {
  const storeHashInput = document.getElementById("bc-store-hash");
  const accessTokenInput = document.getElementById("bc-access-token");
  const channelIdInput = document.getElementById("bc-channel-id");
  const storefrontTokenInput = document.getElementById("bc-storefront-token");

  // BigCommerce calls hit two different hosts (api.bigcommerce.com for the Management API,
  // store-{hash}.mybigcommerce.com for the Storefront GraphQL API), so there's no single
  // "base URL" — the store hash just gates the "enter store info first" check.
  function baseUrl() {
    return storeHashInput.value.trim();
  }

  const ENDPOINTS = [
    {
      key: "bc-storefront-token",
      title: "Generate Storefront Token",
      pathLabel: "https://api.bigcommerce.com/stores/{storeHash}/v3/storefront/api-token",
      hint: "Response's data.token is the Storefront GraphQL bearer token — paste it into \"Storefront Token\" above to use the GraphQL call below.",
      build() {
        const storeHash = storeHashInput.value.trim();
        const channelId = Number(channelIdInput.value.trim()) || 1;
        const body = {
          channel_id: channelId,
          expires_at: 2147483647,
          allowed_cors_origins: [`https://store-${storeHash}.mybigcommerce.com`],
        };
        return {
          url: `https://api.bigcommerce.com/stores/${storeHash}/v3/storefront/api-token`,
          method: "POST",
          headers: { "x-auth-token": accessTokenInput.value.trim(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
      },
    },
    {
      key: "bc-graphql",
      title: "Storefront GraphQL — Product / Catalog",
      pathLabel: "https://store-{storeHash}.mybigcommerce.com/graphql",
      params: [{ id: "entityId", label: "Product entityId (optional)", type: "text" }],
      build(base, get) {
        const storeHash = storeHashInput.value.trim();
        const entityId = get("entityId");
        const query = entityId
          ? `{ site { product(entityId: ${Number(entityId)}) { name sku categories { edges { node { name entityId } } } } } }`
          : "{ site { products(first: 10) { edges { node { name sku entityId } } } } }";
        return {
          url: `https://store-${storeHash}.mybigcommerce.com/graphql`,
          method: "POST",
          headers: { Authorization: `Bearer ${storefrontTokenInput.value.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        };
      },
    },
  ];

  ApiTools.mount(document.getElementById("bc-api-endpoints"), ENDPOINTS, baseUrl);
})();
