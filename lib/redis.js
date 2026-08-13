// Vercel's Redis marketplace integrations don't all inject the same env vars: some
// (Upstash's own dashboard) give a REST URL + token pair; the "KV" prefix connected
// through Vercel's Storage tab was observed to only inject a single connection string
// (KV_REDIS_URL). Support both, behind the same tiny {get,set,del} interface, so the
// rest of the app doesn't care which one is configured.

function createRedisClient() {
  const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    const { Redis } = require("@upstash/redis");
    const client = new Redis({ url: restUrl, token: restToken });
    return {
      get: (key) => client.get(key),
      set: (key, value) => client.set(key, value),
      del: (key) => client.del(key),
      // Upstash's REST API has no generic INFO passthrough in the SDK — usage isn't
      // exposed here; check it in the Upstash console instead.
      usageBytes: async () => null,
    };
  }

  const connectionString = process.env.KV_REDIS_URL || process.env.KV_URL || process.env.REDIS_URL;
  if (connectionString) {
    const IORedis = require("ioredis");
    const client = new IORedis(connectionString, { maxRetriesPerRequest: 3 });
    client.on("error", (err) => console.error("[redis] connection error:", err.message));
    return {
      get: async (key) => {
        const raw = await client.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      set: (key, value) => client.set(key, JSON.stringify(value)),
      del: (key) => client.del(key),
      usageBytes: async () => {
        const info = await client.info("memory");
        const match = /used_memory:(\d+)/.exec(info);
        return match ? Number(match[1]) : null;
      },
    };
  }

  return null;
}

module.exports = { createRedisClient };
