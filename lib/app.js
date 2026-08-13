const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const AdmZip = require("adm-zip");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const Anthropic = require("@anthropic-ai/sdk");
const { Redis } = require("@upstash/redis");
const { createOAuthRouter, verifyAccessToken } = require("./oauth");

const PLATFORMS = {
  prestashop: { label: "PrestaShop", repo: "doofinder/doofinder-prestashop" },
  magento: { label: "Magento", repo: "doofinder/doofinder-magento2" },
  woocommerce: { label: "WooCommerce", repo: "doofinder/doofinder-woocommerce" },
};

// En Vercel el bundle del proyecto es de solo lectura: los releases descargados
// se cachean en /tmp (efímero, puede vaciarse entre invocaciones). En local se
// usa la carpeta repos/ del proyecto para no perder la caché entre reinicios.
const REPOS_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "doopresta-repos") : path.join(__dirname, "..", "repos");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });

function githubRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      headers: {
        "User-Agent": "DooPresta",
        Accept: "application/vnd.github+json",
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
        resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "DooPresta",
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`Download failed: ${res.statusCode}`));
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

function platformDir(platform) {
  return path.join(REPOS_DIR, platform);
}

async function listReleases(platform) {
  return githubRequest(`/repos/${PLATFORMS[platform].repo}/releases`);
}

async function downloadRelease(platform, tag) {
  const baseDir = platformDir(platform);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const targetDir = path.join(baseDir, tag);
  if (fs.existsSync(targetDir)) return targetDir;

  const releases = await listReleases(platform);
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) throw new Error(`Release ${tag} not found`);

  const zipUrl = release.zipball_url;
  const zipPath = path.join(baseDir, `${tag}.zip`);
  await downloadFile(zipUrl, zipPath);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const rootFolder = entries[0].entryName.split("/")[0];
  zip.extractAllTo(baseDir, true);
  fs.renameSync(path.join(baseDir, rootFolder), targetDir);
  fs.unlinkSync(zipPath);

  return targetDir;
}

function listLocalVersions(platform) {
  const baseDir = platformDir(platform);
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir).filter((f) => fs.statSync(path.join(baseDir, f)).isDirectory());
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

async function ensureVersionDir(platform, version) {
  const dir = path.join(platformDir(platform), version);
  if (fs.existsSync(dir)) return dir;
  // En Vercel cada invocacion puede caer en una instancia distinta con su propio
  // /tmp: si esta version no esta en ESTA instancia, la descargamos de nuevo.
  return downloadRelease(platform, version);
}

function safeFilePath(versionDir, relPath) {
  const full = path.resolve(versionDir, relPath);
  if (!full.startsWith(path.resolve(versionDir))) throw new Error("Invalid path");
  return full;
}

// ---------- Web UI + REST API ----------

const SITE_USER = process.env.SITE_USER || "admin";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";

if (!SITE_PASSWORD) {
  console.warn(
    "[WARNING] SITE_PASSWORD is not set — this app (including /api/proxy, which relays requests to any store using the credentials you paste in) is publicly reachable without a login. Set SITE_USER/SITE_PASSWORD to protect it."
  );
}

const app = express();
app.set("trust proxy", 1);

// Secret used to sign OAuth tokens (client_id, authorization codes, access/refresh
// tokens). Shared via env var so it's consistent across serverless instances; falls
// back to SITE_PASSWORD (also shared) rather than forcing one more variable to set up.
const OAUTH_SECRET = process.env.OAUTH_SECRET || SITE_PASSWORD || "insecure-dev-secret";

function checkBasicAuth(req) {
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString();
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === SITE_USER && pass === SITE_PASSWORD;
}

// Handles /register, /authorize, /token and the /.well-known/* discovery endpoints —
// mounted before the Basic Auth gate below so those endpoints stay reachable without
// a Basic Auth header (OAuth clients like claude.ai's remote connector don't send one).
app.use(createOAuthRouter({ secret: OAUTH_SECRET, siteUser: SITE_USER, sitePassword: SITE_PASSWORD }));

if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    // /mcp accepts either Basic Auth (Claude Code CLI, see NOTA) or a Bearer token
    // issued via the OAuth flow above (claude.ai custom connectors) — checked inline
    // in its own handler, so it's excluded from this blanket gate.
    if (req.path === "/mcp") return next();
    if (checkBasicAuth(req)) return next();
    res.set("WWW-Authenticate", 'Basic realm="DooPresta"');
    res.status(401).send("Authentication required");
  });
}

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function requirePlatform(req, res, next) {
  if (!PLATFORMS[req.params.platform]) {
    return res.status(404).json({ error: `Unknown platform "${req.params.platform}"` });
  }
  next();
}

app.get("/api/:platform/releases", requirePlatform, async (req, res) => {
  try {
    const platform = req.params.platform;
    const releases = await listReleases(platform);
    const downloaded = new Set(listLocalVersions(platform));
    res.json(
      releases.map((r) => ({
        tag: r.tag_name,
        name: r.name,
        published_at: r.published_at,
        downloaded: downloaded.has(r.tag_name),
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/:platform/download", requirePlatform, async (req, res) => {
  try {
    const { tag } = req.body;
    const dir = await downloadRelease(req.params.platform, tag);
    res.json({ ok: true, path: dir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/:platform/local", requirePlatform, (req, res) => {
  res.json(listLocalVersions(req.params.platform));
});

// ---------- Store API proxy (bypasses browser CORS, like the DoofKit extension's background script) ----------

function proxyRequest({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error("Invalid URL"));
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return reject(new Error("Only http/https URLs are allowed"));
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(target, { method: method || "GET", headers: headers || {} }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        resolve({ ok: res.statusCode < 400, status: res.statusCode, text: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

app.post("/api/proxy", async (req, res) => {
  try {
    const { url, method, headers, body } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });
    const result = await proxyRequest({ url, method, headers, body });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Shared plugin-inspection tools (used by both MCP and the web chat) ----------

async function doListVersions(platform) {
  // Report every release GitHub knows about, not just what happens to be cached in
  // this instance's ephemeral /tmp (Vercel wipes it unpredictably between invocations) —
  // read_file/search_code auto-download on demand regardless, so "downloaded" here is
  // just a hint, not a requirement to use a version.
  const releases = await listReleases(platform);
  const downloaded = new Set(listLocalVersions(platform));
  return JSON.stringify(
    releases.map((r) => ({ tag: r.tag_name, published_at: r.published_at, downloaded: downloaded.has(r.tag_name) }))
  );
}

async function doListFiles(platform, version) {
  const dir = await ensureVersionDir(platform, version);
  return JSON.stringify(walkFiles(dir));
}

async function doReadFile(platform, version, relPath) {
  const dir = await ensureVersionDir(platform, version);
  const full = safeFilePath(dir, relPath);
  return fs.readFileSync(full, "utf-8");
}

async function doSearchCode(platform, version, query) {
  const dir = await ensureVersionDir(platform, version);
  const files = walkFiles(dir);
  const q = query.toLowerCase();
  const matches = [];
  for (const rel of files) {
    const full = path.join(dir, rel);
    let content;
    try {
      content = fs.readFileSync(full, "utf-8");
    } catch {
      continue; // binary or unreadable file
    }
    content.split("\n").forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        matches.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
    if (matches.length > 200) break;
  }
  return matches.slice(0, 200).join("\n") || "No matches.";
}

// ---------- Shared context (API calls / screenshots / selected version, manually pushed
// from the browser via "Share with MCP") ----------
// Global per platform, not tied to a specific browser — whoever has access to the site can
// overwrite it, and MCP tools always read the most recently shared copy.
//
// Backed by Redis (Upstash, connected via Vercel's Storage tab) when configured, so the data
// survives across serverless instances — unlike REPOS_DIR/tmp, which is fine to lose (plugin
// code just re-downloads), this is small and easy to lose track of if it silently goes stale.
// Falls back to a local JSON file when no Redis env vars are set (e.g. local dev).

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = KV_URL && KV_TOKEN ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;

if (!redis) {
  console.warn(
    "[WARNING] No Redis configured (KV_REST_API_URL/KV_REST_API_TOKEN) — shared context (API calls, " +
      "screenshots, selected version) falls back to local disk, which is not reliable on Vercel."
  );
}

const SHARED_CONTEXT_DIR = path.join(REPOS_DIR, "_shared-context");
if (!redis && !fs.existsSync(SHARED_CONTEXT_DIR)) fs.mkdirSync(SHARED_CONTEXT_DIR, { recursive: true });

function sharedContextPath(platform) {
  return path.join(SHARED_CONTEXT_DIR, `${platform}.json`);
}

function sharedContextKey(platform) {
  return `doopresta:shared-context:${platform}`;
}

async function saveSharedContext(platform, data) {
  const payload = { ...data, savedAt: new Date().toISOString() };
  if (redis) {
    await redis.set(sharedContextKey(platform), payload);
  } else {
    fs.writeFileSync(sharedContextPath(platform), JSON.stringify(payload));
  }
}

async function loadSharedContext(platform) {
  if (redis) {
    return (await redis.get(sharedContextKey(platform))) || null;
  }
  try {
    return JSON.parse(fs.readFileSync(sharedContextPath(platform), "utf-8"));
  } catch {
    return null;
  }
}

async function resetSharedContext(platform) {
  if (redis) {
    await redis.del(sharedContextKey(platform));
  } else {
    try {
      fs.unlinkSync(sharedContextPath(platform));
    } catch {
      // nothing shared yet — fine.
    }
  }
}

app.post("/api/:platform/context", requirePlatform, async (req, res) => {
  try {
    const { apiCall, screenshots, selectedVersion } = req.body || {};
    await saveSharedContext(req.params.platform, { apiCall, screenshots, selectedVersion });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets the web page show what's currently shared, for transparency/debugging.
app.get("/api/:platform/context", requirePlatform, async (req, res) => {
  try {
    const ctx = await loadSharedContext(req.params.platform);
    res.json({
      savedAt: ctx?.savedAt || null,
      selectedVersion: ctx?.selectedVersion || null,
      apiCall: ctx?.apiCall ? { title: ctx.apiCall.title, method: ctx.apiCall.method, url: ctx.apiCall.url, status: ctx.apiCall.status } : null,
      screenshotCount: Array.isArray(ctx?.screenshots) ? ctx.screenshots.length : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/:platform/context/reset", requirePlatform, async (req, res) => {
  try {
    await resetSharedContext(req.params.platform);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function doGetLastApiCall(platform) {
  const ctx = await loadSharedContext(platform);
  if (!ctx || !ctx.apiCall) {
    return "No API call has been shared yet. Ask the user to use the \"Share with MCP\" button on the web page after making an API call.";
  }
  const { title, method, url, headers, status, json } = ctx.apiCall;
  const headerLines = Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  return (
    `[Shared ${ctx.savedAt}] API call — "${title || ""}"\n${method} ${url}\n${headerLines}\n\n` +
    `HTTP ${status}\n${json || ""}`
  );
}

async function doGetScreenshots(platform) {
  const ctx = await loadSharedContext(platform);
  if (!ctx || !Array.isArray(ctx.screenshots)) return [];
  return ctx.screenshots;
}

async function doGetSelectedVersion(platform) {
  const ctx = await loadSharedContext(platform);
  if (!ctx || !ctx.selectedVersion) {
    return "No version has been shared yet. Ask the user to use the \"Share with MCP\" button on the web page — it shares whichever version is currently selected in the dropdown.";
  }
  return `[Shared ${ctx.savedAt}] Selected version: ${ctx.selectedVersion}`;
}

// ---------- MCP server ----------

const PLATFORM_KEYS = Object.keys(PLATFORMS);
const platformParam = z
  .enum(PLATFORM_KEYS)
  .default("prestashop")
  .describe(`E-commerce platform of the plugin: ${PLATFORM_KEYS.join(", ")}. Defaults to prestashop.`);

function buildMcpServer() {
  const server = new McpServer({ name: "doopresta", version: "1.0.0" });

  server.registerTool(
    "list_versions",
    {
      description: "List available plugin versions (from GitHub releases) for a given platform, and whether each is already cached locally.",
      inputSchema: { platform: platformParam },
    },
    async ({ platform }) => ({
      content: [{ type: "text", text: await doListVersions(platform) }],
    })
  );

  server.registerTool(
    "list_files",
    {
      description: "List all files in a downloaded plugin version.",
      inputSchema: { platform: platformParam, version: z.string().describe("Version tag, e.g. v6.0.0") },
    },
    async ({ platform, version }) => ({
      content: [{ type: "text", text: await doListFiles(platform, version) }],
    })
  );

  server.registerTool(
    "read_file",
    {
      description: "Read the full contents of one file from a downloaded plugin version.",
      inputSchema: {
        platform: platformParam,
        version: z.string(),
        path: z.string().describe("File path relative to the plugin root, from list_files"),
      },
    },
    async ({ platform, version, path: relPath }) => ({
      content: [{ type: "text", text: await doReadFile(platform, version, relPath) }],
    })
  );

  server.registerTool(
    "search_code",
    {
      description: "Search for a text string across all files of a downloaded plugin version. Returns matching file paths with line numbers and the matching line.",
      inputSchema: {
        platform: platformParam,
        version: z.string(),
        query: z.string().describe("Text or keyword to search for (case-insensitive)"),
      },
    },
    async ({ platform, version, query }) => ({
      content: [{ type: "text", text: await doSearchCode(platform, version, query) }],
    })
  );

  server.registerTool(
    "get_last_api_call",
    {
      description:
        "Get the last real store API call and response shared from the web app for a given platform, via its \"Share with MCP\" button. " +
        "This is shared, not private to one person — it reflects whoever shared most recently.",
      inputSchema: { platform: platformParam },
    },
    async ({ platform }) => ({
      content: [{ type: "text", text: await doGetLastApiCall(platform) }],
    })
  );

  server.registerTool(
    "get_screenshots",
    {
      description:
        "Get the screenshots most recently shared from the web app for a given platform, via its \"Share with MCP\" button. " +
        "This is shared, not private to one person — it reflects whoever shared most recently.",
      inputSchema: { platform: platformParam },
    },
    async ({ platform }) => {
      const images = await doGetScreenshots(platform);
      if (images.length === 0) {
        return { content: [{ type: "text", text: "No screenshots have been shared yet." }] };
      }
      return { content: images.map((img) => ({ type: "image", data: img.base64, mimeType: img.mediaType })) };
    }
  );

  server.registerTool(
    "get_selected_version",
    {
      description:
        "Get the plugin version currently selected in the web app's dropdown for a given platform, shared via its \"Share with MCP\" button. " +
        "Use this before list_files/read_file/search_code when the user hasn't specified a version explicitly — it tells you which one they're actually looking at. " +
        "This is shared, not private to one person — it reflects whoever shared most recently.",
      inputSchema: { platform: platformParam },
    },
    async ({ platform }) => ({
      content: [{ type: "text", text: await doGetSelectedVersion(platform) }],
    })
  );

  return server;
}

app.post("/mcp", async (req, res) => {
  if (SITE_PASSWORD && !checkBasicAuth(req) && !verifyAccessToken(OAUTH_SECRET, req.headers.authorization)) {
    const resourceMetadataUrl = `${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource`;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    return res.status(401).json({ error: "unauthorized" });
  }

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ---------- Web chat (Claude API) ----------

const CHAT_TOOLS = [
  {
    name: "list_versions",
    description: "List available plugin versions (from GitHub releases), and whether each is already cached locally.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_files",
    description: "List all files in a downloaded plugin version.",
    input_schema: {
      type: "object",
      properties: { version: { type: "string", description: "Version tag, e.g. 8.2.3" } },
      required: ["version"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of one file from a downloaded plugin version.",
    input_schema: {
      type: "object",
      properties: {
        version: { type: "string" },
        path: { type: "string", description: "File path relative to the plugin root, from list_files" },
      },
      required: ["version", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: "Search for a text string across all files of a downloaded plugin version. Returns matching file paths with line numbers and the matching line.",
    input_schema: {
      type: "object",
      properties: {
        version: { type: "string" },
        query: { type: "string", description: "Text or keyword to search for (case-insensitive)" },
      },
      required: ["version", "query"],
      additionalProperties: false,
    },
  },
];

async function runChatTool(platform, name, input) {
  switch (name) {
    case "list_versions":
      return doListVersions(platform);
    case "list_files":
      return doListFiles(platform, input.version);
    case "read_file":
      return doReadFile(platform, input.version, input.path);
    case "search_code":
      return doSearchCode(platform, input.version, input.query);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function chatSystemPrompt(platform, selectedVersion) {
  const label = PLATFORMS[platform].label;
  return (
    `You are an assistant embedded in a web app for exploring the source code of Doofinder's ${label} plugin. ` +
    "Always use the available tools to inspect the real code before answering — there is no need to ask the user to download anything first, " +
    "the tools automatically download the requested version if it isn't already present. " +
    "Versions are identified by tags as returned by list_versions; if the user writes the version without a leading 'v' and the tag has one, try it with the 'v' anyway. " +
    "Answer precisely, citing file paths and line numbers when useful. If a version doesn't exist in the repository, say so clearly. " +
    "A user message may start with a '[Context: response from ...]' block containing the JSON response from a real store's API call, and/or attached screenshots — use them together with the plugin code to answer, e.g. to explain why a field is missing, malformed, or what an error screen means." +
    (selectedVersion
      ? ` The version currently selected in the UI is "${selectedVersion}" — use this exact tag with list_files/read_file/search_code unless the user's question clearly asks about a different version. Don't rely on list_versions to confirm it exists first, just use it directly; the tools will download it on demand if needed.`
      : "")
  );
}

// ---------- Prompt caching helpers ----------
// System prompt + tools are identical on every request for a given platform, and the
// growing conversation is identical up to the previous turn — cache both so the agentic
// loop's repeated resends (and multi-turn chat history) are billed at cache-read rates
// instead of full price. See shared/prompt-caching.md.

function asContentBlocks(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function markConvoForCaching(convo) {
  convo.forEach((m) => {
    if (Array.isArray(m.content)) {
      m.content.forEach((block) => delete block.cache_control);
    }
  });
  const last = convo[convo.length - 1];
  const blocks = asContentBlocks(last.content);
  last.content = blocks;
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
}

const CHAT_MODELS = ["claude-opus-5", "claude-sonnet-5"];
const DEFAULT_CHAT_MODEL = "claude-sonnet-5";

app.post("/api/:platform/chat", requirePlatform, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on the server." });
  }
  const platform = req.params.platform;
  const { messages, version, model: requestedModel } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages is required" });
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));

  const buildChatParams = (model) => ({
    model,
    max_tokens: 4096,
    system: [{ type: "text", text: chatSystemPrompt(platform, version), cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: CHAT_TOOLS,
    messages: convo,
  });

  try {
    let reply = "";
    let model = CHAT_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_CHAT_MODEL;
    for (let i = 0; i < 8; i++) {
      markConvoForCaching(convo);
      let response;
      try {
        response = await anthropic.messages.create(buildChatParams(model));
      } catch (e) {
        if (model === "claude-opus-5" && e.status === 529) {
          model = "claude-sonnet-5";
          response = await anthropic.messages.create(buildChatParams(model));
        } else {
          throw e;
        }
      }

      if (response.stop_reason === "refusal") {
        reply = "The model declined to answer this request.";
        break;
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      if (toolUses.length === 0) {
        reply = text;
        break;
      }

      convo.push({ role: "assistant", content: response.content });
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            return { type: "tool_result", tool_use_id: tu.id, content: await runChatTool(platform, tu.name, tu.input) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: tu.id, content: e.message, is_error: true };
          }
        })
      );
      convo.push({ role: "user", content: toolResults });

      if (i === 7) reply = text || "I couldn't complete this request.";
    }

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
