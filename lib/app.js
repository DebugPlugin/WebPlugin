const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const archiver = require("archiver");
const multer = require("multer");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const Anthropic = require("@anthropic-ai/sdk");
const { createOAuthRouter, verifyAccessToken, sign, verify } = require("./oauth");
const { createRedisClient } = require("./redis");

const PLATFORMS = {
  prestashop: { label: "PrestaShop", repo: "doofinder/doofinder-prestashop" },
  magento: { label: "Magento", repo: "doofinder/doofinder-magento2" },
  woocommerce: { label: "WooCommerce", repo: "doofinder/doofinder-woocommerce" },
  // These 5 have no browsable plugin source in this app: the woocommerce/magento/prestashop repos
  // above are public, but doofinder-shopware6/-bigcommerce/-shoper/-shopify are private (return 404
  // without an authenticated GitHub token this app doesn't have), and Shopware 5 has no known repo
  // at all. So `repo` stays null here and list_versions/list_files/read_file/search_code short-circuit
  // with a friendly message instead of trying (and failing) to hit GitHub. Store & API tools still work.
  shopware: { label: "Shopware", repo: null },
  shopware5: { label: "Shopware 5", repo: null },
  shoper: { label: "Shoper", repo: null },
  shopify: { label: "Shopify", repo: null },
  bigcommerce: { label: "BigCommerce", repo: null },
  // Catch-all for anything without a dedicated page — no plugin source and no
  // store-specific API tooling, just the shared JS/CSS extractor + Notes/Screenshots.
  others: { label: "Others", repo: null },
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

function hasCode(platform) {
  return !!PLATFORMS[platform].repo;
}

const NO_CODE_MSG =
  "This platform's plugin source code isn't available to browse from this app (no accessible GitHub repo is configured for it). " +
  "Use the Store & API tools / Share with MCP features instead.";

async function listReleases(platform) {
  if (!hasCode(platform)) return [];
  return githubRequest(`/repos/${PLATFORMS[platform].repo}/releases`);
}

async function downloadRelease(platform, tag) {
  if (!hasCode(platform)) throw new Error(NO_CODE_MSG);
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

// Signed, stateless session cookie for the web UI's login page — reuses the OAuth
// sign()/verify() helpers (and OAUTH_SECRET) so it needs no extra shared secret or
// server-side session store, consistent with the rest of this file's Vercel-serverless
// (no shared memory between instances) design.
const SESSION_COOKIE = "dpe_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function checkSessionAuth(req) {
  const cookies = parseCookies(req);
  const payload = verify(OAUTH_SECRET, cookies[SESSION_COOKIE]);
  return !!payload && payload.typ === "session";
}

// Handles /register, /authorize, /token and the /.well-known/* discovery endpoints —
// mounted before the Basic Auth gate below so those endpoints stay reachable without
// a Basic Auth header (OAuth clients like claude.ai's remote connector don't send one).
app.use(createOAuthRouter({ secret: OAUTH_SECRET, siteUser: SITE_USER, sitePassword: SITE_PASSWORD }));

// Needed before /api/login below; harmless to have earlier than the auth gate since it
// only parses request bodies, it doesn't expose anything.
app.use(express.json({ limit: "15mb" }));

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DPE — Login</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #1B1851;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #f2f0ff;
  }
  .login-box {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 20px;
    padding: 44px 36px;
    width: 100%;
    max-width: 360px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    position: relative;
    overflow: hidden;
  }
  .login-box::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(135deg, #2D2599, #8878FE);
  }
  .login-icon {
    width: 48px;
    height: 48px;
    margin: 0 auto 20px;
    border-radius: 12px;
    background: #5B4FE0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 15px;
    letter-spacing: 0.5px;
  }
  h1 { font-size: 1.5em; font-weight: 800; margin-bottom: 6px; }
  h1 .oo { color: #FFF031; }
  p.tagline { color: #b8b3e6; font-size: 13px; margin-bottom: 28px; }
  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 10px;
    color: #f2f0ff;
    font-size: 14px;
    font-family: inherit;
    margin-bottom: 12px;
    outline: none;
    transition: border-color 0.2s;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    border-color: #FFF031;
  }
  input::placeholder { color: #8880c0; }
  button {
    width: 100%;
    padding: 12px;
    background: #FFF031;
    color: #1B1851;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    margin-top: 6px;
    transition: background 0.15s;
  }
  button:hover:not(:disabled) { background: #f2e522; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error {
    display: none;
    color: #ffb4b4;
    background: rgba(220, 38, 38, 0.15);
    border: 1px solid rgba(220, 38, 38, 0.3);
    border-radius: 8px;
    padding: 10px;
    font-size: 13px;
    margin-top: 14px;
  }
  .error.active { display: block; }
</style>
</head>
<body>
  <div class="login-box">
    <div class="login-icon">DPE</div>
    <h1>D<span class="oo">OO</span>FINDER Plugin Explorer</h1>
    <p class="tagline">Sign in to continue</p>
    <form id="login-form">
      <input type="text" id="username" placeholder="User" autocomplete="username" autofocus required>
      <input type="password" id="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit" id="login-btn">Access</button>
    </form>
    <div class="error" id="error-msg">Wrong user or password. Try again.</div>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('login-btn');
      const error = document.getElementById('error-msg');
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      error.classList.remove('active');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.ok) {
          window.location.href = '/';
        } else {
          error.classList.add('active');
          document.getElementById('password').value = '';
          document.getElementById('password').focus();
        }
      } catch (err) {
        error.textContent = 'Connection error. Try again.';
        error.classList.add('active');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Access';
      }
    });
  </script>
</body>
</html>`;

app.post("/api/login", (req, res) => {
  if (!SITE_PASSWORD) return res.status(500).json({ error: "Login not configured" });
  const { username, password } = req.body || {};
  if (username !== SITE_USER || password !== SITE_PASSWORD) {
    return res.status(401).json({ ok: false });
  }
  const token = sign(OAUTH_SECRET, { typ: "session", exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS });
  const isHttps = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${isHttps ? "; Secure" : ""}`
  );
  res.json({ ok: true });
});

app.get("/login", (req, res) => {
  res.type("html").send(LOGIN_PAGE_HTML);
});

app.post("/api/logout", (req, res) => {
  const isHttps = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`);
  res.json({ ok: true });
});

if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    // /mcp accepts either Basic Auth (Claude Code CLI, see NOTA) or a Bearer token
    // issued via the OAuth flow above (claude.ai custom connectors) — checked inline
    // in its own handler, so it's excluded from this blanket gate. /login, /api/login
    // and /favicon.svg must stay reachable without a session for the login page itself
    // to load.
    if (req.path === "/mcp" || req.path === "/login" || req.path === "/api/login" || req.path === "/favicon.svg") {
      return next();
    }
    if (checkBasicAuth(req) || checkSessionAuth(req)) return next();
    if (req.method === "GET" && req.accepts(["html", "json"]) === "html") {
      return res.redirect("/login");
    }
    res.set("WWW-Authenticate", 'Basic realm="DPE"');
    res.status(401).json({ error: "Authentication required" });
  });
}

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
    if (!hasCode(req.params.platform)) return res.status(400).json({ error: NO_CODE_MSG });
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

// ---------- Digest Auth proxy (Shopware 5's legacy /api/*) ----------
// Shopware 5's REST API is protected with HTTP Digest Auth (username + apikey), which needs a
// two-round-trip handshake: an unauthenticated request to collect the 401 + WWW-Authenticate
// challenge, then a second request with a computed Authorization header. Doing this server-side
// (unlike a browser extension) needs no special CORS workaround — it's just two plain requests.

function md5Hex(str) {
  return crypto.createHash("md5").update(str, "utf8").digest("hex");
}

function parseDigestChallenge(header) {
  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(header || ""))) {
    params[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return params;
}

function buildDigestHeader(challenge, method, uri, user, pass) {
  const ha1 = md5Hex(`${user}:${challenge.realm}:${pass}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  let response, extra;
  if (challenge.qop) {
    const qop = challenge.qop.split(",")[0].trim();
    response = md5Hex(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5Hex(`${ha1}:${challenge.nonce}:${ha2}`);
    extra = "";
  }
  const opaquePart = challenge.opaque ? `, opaque="${challenge.opaque}"` : "";
  return `Digest username="${user}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"${extra}${opaquePart}`;
}

function digestRequest({ url, method, user, pass }) {
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
    const uri = target.pathname + target.search;

    function doReq(headers) {
      return new Promise((res2, rej2) => {
        const r = lib.request(target, { method: method || "GET", headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => res2({ statusCode: res.statusCode, headers: res.headers, data }));
        });
        r.on("error", rej2);
        r.end();
      });
    }

    doReq({})
      .then((first) => {
        if (first.statusCode !== 401 || !first.headers["www-authenticate"]) {
          return resolve({ ok: first.statusCode < 400, status: first.statusCode, text: first.data, headers: first.headers });
        }
        const challenge = parseDigestChallenge(first.headers["www-authenticate"]);
        const authHeader = buildDigestHeader(challenge, method || "GET", uri, user, pass);
        return doReq({ Authorization: authHeader }).then((second) => {
          resolve({ ok: second.statusCode < 400, status: second.statusCode, text: second.data, headers: second.headers });
        });
      })
      .catch(reject);
  });
}

app.post("/api/proxy-digest", async (req, res) => {
  try {
    const { url, method, user, pass } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });
    if (!user || !pass) return res.status(400).json({ error: "user and pass are required" });
    const result = await digestRequest({ url, method, user, pass });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- JS/CSS extractor (shared across every platform page) ----------
// Pulls every .js/.css a page loads (plus inline <script>/<style> bodies) using
// plain HTTP requests — no headless browser. Ported from the standalone LOL
// extractor tool; ties into this app so every platform page gets the same
// section instead of shipping a separate app.

const EXTRACTOR_MAX_FILES = 200;
const EXTRACTOR_MAX_DEPTH = 5;
const EXTRACTOR_MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB per file
const EXTRACTOR_FETCH_TIMEOUT_MS = 12000;
const EXTRACTOR_CONCURRENCY = 6;

const EXTRACTOR_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Matches quoted strings ending in ".js" or ".css" (optionally with a query string):
// absolute (http/https), protocol-relative (//), root-relative (/x), relative (./ ../) or bare filename.
const EXTRACTOR_ASSET_REF_RE =
  /["'`]((?:https?:)?\/\/[^"'`\s>]+?\.(?:js|css)(?:\?[^"'`\s>]*)?|\/[^"'`\s>]+?\.(?:js|css)(?:\?[^"'`\s>]*)?|\.{1,2}\/[^"'`\s>]+?\.(?:js|css)(?:\?[^"'`\s>]*)?|[A-Za-z0-9_\-.]+?\.(?:js|css)(?:\?[^"'`\s>]*)?)["'`]/g;

// Matches @import url(foo.css) / url(foo.css) without quotes (CSS-only syntax).
const EXTRACTOR_CSS_UNQUOTED_URL_RE = /url\(\s*([^)'"\s]+?\.css(?:\?[^)\s]*)?)\s*\)/gi;

function extractorRefKind(ref) {
  return /\.css(\?[^"'`\s>]*)?$/i.test(ref) ? "css" : "js";
}

function extractorWantsKind(kind, filter) {
  return filter === "all" || filter === kind;
}

function extractorClassify(u) {
  try {
    const pathname = new URL(u).pathname.toLowerCase();
    if (pathname.endsWith(".css")) return "css";
    return "js";
  } catch {
    return "js";
  }
}

function extractorSameNormalized(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function extractorFetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), EXTRACTOR_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": EXTRACTOR_UA, Accept: "*/*", ...opts.headers },
    });
  } finally {
    clearTimeout(t);
  }
}

const EXTRACTOR_SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
const EXTRACTOR_LINK_TAG_RE = /<link\b[^>]*>/gi;
const EXTRACTOR_LINK_HREF_RE = /\bhref\s*=\s*(["'])(.*?)\1/i;
const EXTRACTOR_LINK_REL_RE = /\brel\s*=\s*(["'])(.*?)\1/i;

function extractorFindScriptSrcTags(html) {
  const refs = [];
  let m;
  EXTRACTOR_SCRIPT_SRC_RE.lastIndex = 0;
  while ((m = EXTRACTOR_SCRIPT_SRC_RE.exec(html))) refs.push(m[2]);
  return refs;
}

// <script>...</script> without a src: the code lives directly in the HTML
// (trackers, integrations like the Doofinder snippet, etc.), so there's no
// URL to fetch — lift the body out as its own pseudo-file instead.
const EXTRACTOR_SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const EXTRACTOR_SCRIPT_HAS_SRC_RE = /\bsrc\s*=/i;
const EXTRACTOR_SCRIPT_TYPE_ATTR_RE = /\btype\s*=\s*(["'])(.*?)\1/i;
const EXTRACTOR_NON_JS_SCRIPT_TYPE_RE = /json|template|text\/html/i;

function extractorFindInlineScripts(html) {
  const scripts = [];
  let m;
  EXTRACTOR_SCRIPT_TAG_RE.lastIndex = 0;
  while ((m = EXTRACTOR_SCRIPT_TAG_RE.exec(html))) {
    const attrs = m[1];
    if (EXTRACTOR_SCRIPT_HAS_SRC_RE.test(attrs)) continue;
    const typeMatch = EXTRACTOR_SCRIPT_TYPE_ATTR_RE.exec(attrs);
    const type = typeMatch ? typeMatch[2].toLowerCase().trim() : "";
    if (type && EXTRACTOR_NON_JS_SCRIPT_TYPE_RE.test(type)) continue;
    const content = m[2].trim();
    if (!content) continue;
    scripts.push(content);
  }
  return scripts;
}

// Heuristic redaction for the one place sensitive data can actually leak:
// inline <script>/<style> content. Unlike external .js/.css files (shared,
// static, same for every visitor), inline content can be server-rendered
// per-session and embed a real logged-in user's own data (email, tokens…).
// Pattern-based, not a guarantee — it catches the common shapes.
function extractorRedactSensitiveData(text) {
  let count = 0;
  const hit = (replacement) => (...args) => {
    count++;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  };
  let out = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, hit("[REDACTED_EMAIL]"));
  out = out.replace(/eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/g, hit("[REDACTED_JWT]"));
  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*["'`])([^"'`]{6,})(["'`])/gi,
    hit((_, pre, val, post) => `${pre}[REDACTED_SECRET]${post}`)
  );
  out = out.replace(/\b(?:\d[ -]?){13,16}\b/g, hit("[REDACTED_NUMBER]"));
  return { text: out, count };
}

const EXTRACTOR_STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

function extractorFindInlineStyles(html) {
  const styles = [];
  let m;
  EXTRACTOR_STYLE_TAG_RE.lastIndex = 0;
  while ((m = EXTRACTOR_STYLE_TAG_RE.exec(html))) {
    const content = m[1].trim();
    if (content) styles.push(content);
  }
  return styles;
}

// <link rel="stylesheet" href="..."> and <link rel="preload" as="style" href="...">
function extractorFindLinkStylesheetTags(html) {
  const refs = [];
  let m;
  EXTRACTOR_LINK_TAG_RE.lastIndex = 0;
  while ((m = EXTRACTOR_LINK_TAG_RE.exec(html))) {
    const tag = m[0];
    const hrefMatch = EXTRACTOR_LINK_HREF_RE.exec(tag);
    if (!hrefMatch) continue;
    const relMatch = EXTRACTOR_LINK_REL_RE.exec(tag);
    const rel = (relMatch ? relMatch[2] : "").toLowerCase();
    const href = hrefMatch[2];
    if (rel.includes("stylesheet") || /\.css(\?|$)/i.test(href)) refs.push(href);
  }
  return refs;
}

// A match is a genuine literal only if it contains no template-literal
// interpolation (`${...}`) — those come from backtick strings whose real
// value is built at runtime and can't be resolved without executing the JS.
function extractorIsLiteralRef(ref) {
  return !ref.includes("${");
}

function extractorFindAssetRefs(text) {
  const refs = new Set();
  let m;
  EXTRACTOR_ASSET_REF_RE.lastIndex = 0;
  while ((m = EXTRACTOR_ASSET_REF_RE.exec(text))) {
    if (extractorIsLiteralRef(m[1])) refs.add(m[1]);
  }
  EXTRACTOR_CSS_UNQUOTED_URL_RE.lastIndex = 0;
  while ((m = EXTRACTOR_CSS_UNQUOTED_URL_RE.exec(text))) {
    if (extractorIsLiteralRef(m[1])) refs.add(m[1]);
  }
  return refs;
}

/**
 * Extracts, recursively and using only plain HTTP requests (no headless
 * browser), every .js/.css referenced by a page: <script src>/<link
 * stylesheet> in the HTML, plus anything referenced inside the downloaded
 * code itself (chunks, @import, loaders, trackers, etc.).
 */
async function extractorExtractAll(pageUrl, opts = {}) {
  // inlineOnly: skip everything fetchable over HTTP (a HAR import already
  // covers those — they're real network requests) and return only the
  // <script>/<style> bodies embedded directly in the HTML, which never show
  // up in a HAR because the browser never requests them.
  const inlineOnly = !!opts.inlineOnly;
  const kindFilter = ["js", "css"].includes(opts.kind) ? opts.kind : "all";
  const results = new Map(); // normalizedUrl -> { url, foundVia, buffer, size, contentType, error }
  const seen = new Set();
  const queue = []; // { url, depth, foundVia }

  const res = await extractorFetchWithTimeout(pageUrl, { headers: { Accept: "text/html,application/xhtml+xml,*/*" } });
  if (!res.ok) throw new Error(`No se pudo cargar la página (HTTP ${res.status})`);
  const html = await res.text();
  const base = res.url || pageUrl;

  if (!inlineOnly) {
    if (extractorWantsKind("js", kindFilter)) {
      for (const src of extractorFindScriptSrcTags(html)) {
        try {
          queue.push({ url: new URL(src, base).toString(), depth: 0, foundVia: "html:<script src>" });
        } catch {}
      }
    }
    if (extractorWantsKind("css", kindFilter)) {
      for (const href of extractorFindLinkStylesheetTags(html)) {
        try {
          queue.push({ url: new URL(href, base).toString(), depth: 0, foundVia: "html:<link stylesheet>" });
        } catch {}
      }
    }
    for (const ref of extractorFindAssetRefs(html)) {
      if (!extractorWantsKind(extractorRefKind(ref), kindFilter)) continue;
      try {
        queue.push({ url: new URL(ref, base).toString(), depth: 0, foundVia: "html:inline reference" });
      } catch {}
    }
  }

  const redactEnabled = opts.redact !== false;

  if (extractorWantsKind("js", kindFilter)) {
    extractorFindInlineScripts(html).forEach((content, i) => {
      const idx = i + 1;
      const key = `${base}#inline-script-${idx}`;
      const { text: safe, count } = redactEnabled ? extractorRedactSensitiveData(content) : { text: content, count: 0 };
      const buf = Buffer.from(safe, "utf8");
      results.set(key, {
        url: key,
        foundVia: "html:<script inline>" + (count ? ` — ${count} dato(s) sensible(s) redactado(s)` : ""),
        depth: 0,
        kind: "js",
        buffer: buf,
        size: buf.length,
        contentType: "application/javascript (inline)",
        inline: true,
        inlineIndex: idx,
        redactedCount: count,
      });
    });
  }

  if (extractorWantsKind("css", kindFilter)) {
    extractorFindInlineStyles(html).forEach((content, i) => {
      const idx = i + 1;
      const key = `${base}#inline-style-${idx}`;
      const { text: safe, count } = redactEnabled ? extractorRedactSensitiveData(content) : { text: content, count: 0 };
      const buf = Buffer.from(safe, "utf8");
      results.set(key, {
        url: key,
        foundVia: "html:<style inline>" + (count ? ` — ${count} dato(s) sensible(s) redactado(s)` : ""),
        depth: 0,
        kind: "css",
        buffer: buf,
        size: buf.length,
        contentType: "text/css (inline)",
        inline: true,
        inlineIndex: idx,
        redactedCount: count,
      });
    });
  }

  async function worker() {
    while (queue.length && results.size < EXTRACTOR_MAX_FILES) {
      const item = queue.shift();
      if (!item) return;
      const norm = extractorSameNormalized(item.url);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);

      const entry = { url: item.url, foundVia: item.foundVia, depth: item.depth, kind: extractorClassify(item.url) };
      try {
        const r = await extractorFetchWithTimeout(item.url);
        const buf = Buffer.from(await r.arrayBuffer());
        entry.size = buf.length;
        entry.contentType = r.headers.get("content-type") || "";
        entry.status = r.status;
        if (r.ok && buf.length <= EXTRACTOR_MAX_FILE_BYTES) {
          entry.buffer = buf;
          if (item.depth < EXTRACTOR_MAX_DEPTH) {
            const text = buf.toString("utf8");
            for (const ref of extractorFindAssetRefs(text)) {
              if (!extractorWantsKind(extractorRefKind(ref), kindFilter)) continue;
              try {
                const abs = new URL(ref, item.url).toString();
                const n2 = extractorSameNormalized(abs);
                if (n2 && !seen.has(n2)) {
                  queue.push({ url: abs, depth: item.depth + 1, foundVia: `${entry.kind}:${item.url}` });
                }
              } catch {}
            }
          }
        } else if (!r.ok) {
          entry.error = `HTTP ${r.status}`;
        } else {
          entry.error = "Archivo demasiado grande, omitido";
        }
      } catch (e) {
        entry.error = e.name === "AbortError" ? "Timeout" : String(e.message || e);
      }

      results.set(norm, entry);
    }
  }

  await Promise.all(Array.from({ length: EXTRACTOR_CONCURRENCY }, () => worker()));

  return { pageUrl: base, files: Array.from(results.values()) };
}

// In-memory result cache, mirrors REPOS_DIR's "fine to lose between serverless
// instances" tradeoff — a scan/import is cheap to redo, so no Redis needed here.
const extractorCache = new Map(); // token -> { files, pageUrl, createdAt }
const EXTRACTOR_CACHE_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of extractorCache) {
    if (now - entry.createdAt > EXTRACTOR_CACHE_TTL_MS) extractorCache.delete(token);
  }
}, 60 * 1000).unref();

function extractorIsValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const extractorUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

app.post("/api/extractor/scan", async (req, res) => {
  const { url, inlineOnly, kind, redact } = req.body || {};
  if (!url || !extractorIsValidUrl(url)) {
    return res.status(400).json({ error: "URL inválida. Usa http:// o https://" });
  }
  try {
    const { pageUrl, files } = await extractorExtractAll(url, { inlineOnly: !!inlineOnly, kind, redact: redact !== false });
    const token = crypto.randomBytes(8).toString("hex");
    extractorCache.set(token, { files, pageUrl, createdAt: Date.now() });

    const list = files.map((f) => ({
      url: f.url,
      kind: f.kind,
      size: f.size ?? null,
      contentType: f.contentType || null,
      foundVia: f.foundVia,
      ok: !f.error,
      error: f.error || null,
      redactedCount: f.redactedCount || 0,
    }));

    res.json({ token, pageUrl, count: list.length, files: list });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/**
 * Imports a .har exported from a real browser's Network tab (Chrome DevTools
 * → right-click the request list → "Save all as HAR with content"). Nothing
 * is guessed here: these are exactly the JS/CSS requests the browser made.
 */
app.post("/api/extractor/import-har", extractorUpload.array("har", 10), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: "Sube uno o varios archivos .har" });
  }

  const hars = [];
  for (const file of req.files) {
    try {
      hars.push(JSON.parse(file.buffer.toString("utf8")));
    } catch {
      return res.status(400).json({ error: `${file.originalname} no es un HAR válido (JSON inválido)` });
    }
  }

  const results = new Map();

  for (const har of hars) {
    const entries = har?.log?.entries || [];
    for (const entry of entries) {
      const url = entry?.request?.url;
      if (!url) continue;
      const mimeType = (entry.response?.content?.mimeType || "").toLowerCase();
      const resourceType = (entry._resourceType || "").toLowerCase();

      let kind = null;
      if (resourceType === "script" || mimeType.includes("javascript") || mimeType.includes("ecmascript") || /\.js(\?|$)/i.test(url)) {
        kind = "js";
      } else if (resourceType === "stylesheet" || mimeType.includes("css") || /\.css(\?|$)/i.test(url)) {
        kind = "css";
      }
      if (!kind) continue;

      const norm = extractorSameNormalized(url);
      if (!norm || results.has(norm)) continue;

      let buffer = null;
      const content = entry.response?.content;
      if (content && typeof content.text === "string" && content.text.length) {
        try {
          buffer = content.encoding === "base64" ? Buffer.from(content.text, "base64") : Buffer.from(content.text, "utf8");
        } catch {}
      }

      results.set(norm, {
        url,
        kind,
        buffer,
        size: buffer ? buffer.length : entry.response?.content?.size ?? entry.response?.bodySize ?? null,
        foundVia: "network:har (real)",
        status: entry.response?.status,
      });
    }
  }

  const list = Array.from(results.values());

  // Some HAR exports skip the embedded body ("Save all as HAR" without "with
  // content"): as a last resort, re-download the exact URL already captured
  // (nothing to guess, the real URL is already known).
  const toFetch = list.filter((f) => !f.buffer);
  if (toFetch.length) {
    let idx = 0;
    async function worker() {
      while (idx < toFetch.length) {
        const item = toFetch[idx++];
        try {
          const r = await extractorFetchWithTimeout(item.url);
          const buf = Buffer.from(await r.arrayBuffer());
          if (r.ok) {
            item.buffer = buf;
            item.size = buf.length;
          } else {
            item.error = `HTTP ${r.status}`;
          }
        } catch (e) {
          item.error = e.name === "AbortError" ? "Timeout" : String(e.message || e);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(EXTRACTOR_CONCURRENCY, toFetch.length) }, worker));
  }

  const token = crypto.randomBytes(8).toString("hex");
  const pageUrl =
    req.files.length > 1
      ? `${req.files.length} archivos HAR importados (${req.files.map((f) => f.originalname).join(", ")})`
      : hars[0]?.log?.pages?.[0]?.title || hars[0]?.log?.entries?.[0]?.request?.url || req.files[0].originalname;
  extractorCache.set(token, { files: list, pageUrl, createdAt: Date.now() });

  const outList = list.map((f) => ({
    url: f.url,
    kind: f.kind,
    size: f.size ?? null,
    foundVia: f.foundVia,
    ok: !!f.buffer,
    error: f.error || (f.buffer ? null : "Sin contenido embebido en el HAR y no se pudo re-descargar"),
  }));

  res.json({ token, pageUrl, count: outList.length, files: outList });
});

app.get("/api/extractor/download/:token", async (req, res) => {
  const entry = extractorCache.get(req.params.token);
  if (!entry) {
    return res.status(404).json({ error: "Resultado no encontrado o expirado. Vuelve a escanear." });
  }

  const kindFilter = ["js", "css"].includes(req.query.kind) ? req.query.kind : "all";
  const okFiles = entry.files.filter((f) => f.buffer && (kindFilter === "all" || f.kind === kindFilter));
  if (!okFiles.length) {
    return res.status(404).json({ error: "No hay archivos descargables para ese filtro." });
  }

  const zipName = kindFilter === "js" ? "js-extraidos.zip" : kindFilter === "css" ? "css-extraidos.zip" : "recursos-extraidos.zip";
  res.attachment(zipName);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  const usedNames = new Set();
  for (const f of okFiles) {
    let u;
    try {
      u = new URL(f.url);
    } catch {
      continue;
    }
    const kind = f.kind || extractorClassify(f.url);
    const ext = kind === "css" ? ".css" : ".js";
    const host = u.hostname.replace(/[^a-zA-Z0-9.\-]/g, "_");
    let filename;
    if (f.inline) {
      filename = `inline-${kind === "css" ? "style" : "script"}-${f.inlineIndex}${ext}`;
    } else {
      filename = path.basename(u.pathname) || `index${ext}`;
      if (!filename.toLowerCase().endsWith(ext)) filename += ext;
    }
    let zipPath = `${kind}/${host}/${filename}`;
    let i = 2;
    while (usedNames.has(zipPath)) {
      const re = new RegExp(`\\${ext}$`, "i");
      zipPath = `${kind}/${host}/${filename.replace(re, "")}-${i}${ext}`;
      i++;
    }
    usedNames.add(zipPath);
    archive.append(f.buffer, { name: zipPath });
  }

  await archive.finalize();
});

// ---------- Shared plugin-inspection tools (used by both MCP and the web chat) ----------

async function doListVersions(platform) {
  if (!hasCode(platform)) return NO_CODE_MSG;
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
  if (!hasCode(platform)) return NO_CODE_MSG;
  const dir = await ensureVersionDir(platform, version);
  return JSON.stringify(walkFiles(dir));
}

async function doReadFile(platform, version, relPath) {
  if (!hasCode(platform)) return NO_CODE_MSG;
  const dir = await ensureVersionDir(platform, version);
  const full = safeFilePath(dir, relPath);
  return fs.readFileSync(full, "utf-8");
}

async function doSearchCode(platform, version, query) {
  if (!hasCode(platform)) return NO_CODE_MSG;
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

const redis = createRedisClient();

if (!redis) {
  console.warn(
    "[WARNING] No Redis configured (KV_REST_API_URL/KV_REST_API_TOKEN or KV_REDIS_URL) — shared context (API calls, " +
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
    const { apiCall, screenshots, selectedVersion, includeCode, notes } = req.body || {};
    await saveSharedContext(req.params.platform, { apiCall, screenshots, selectedVersion, includeCode, notes });
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
      includeCode: ctx?.includeCode !== false,
      notes: ctx?.notes ? 1 : 0,
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

// REDIS_LIMIT_MB: set to match your plan if it isn't the 30MB free-tier default.
const REDIS_LIMIT_MB = Number(process.env.REDIS_LIMIT_MB) || 30;

app.get("/api/redis-usage", async (req, res) => {
  try {
    if (!redis || !redis.usageBytes) return res.json({ available: false });
    const usedBytes = await redis.usageBytes();
    if (usedBytes == null) return res.json({ available: false });
    res.json({ available: true, usedBytes, limitBytes: REDIS_LIMIT_MB * 1024 * 1024 });
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

async function doGetNotes(platform) {
  const ctx = await loadSharedContext(platform);
  if (!ctx || !ctx.notes) {
    return "No notes have been shared yet. Ask the user to check \"Include notes\" and use the \"Share with MCP\" button on the web page.";
  }
  return `[Shared ${ctx.savedAt}] Notes:\n${ctx.notes}`;
}

// ---------- MCP server ----------

const PLATFORM_KEYS = Object.keys(PLATFORMS);
const platformParam = z
  .enum(PLATFORM_KEYS)
  .describe(`E-commerce platform of the plugin: ${PLATFORM_KEYS.join(", ")}. Required — ask the user if it's not clear which platform they mean, don't assume one.`);

function buildMcpServer() {
  const server = new McpServer({
    name: "DPEServer",
    version: "1.0.0",
    instructions:
      "Only use the tools from this server when the user's message begins with the literal prefix \"DPE:\". " +
      "If the message doesn't start with that prefix, don't call any tool from this server, even if it seems relevant.",
  });

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

  const CODE_ACCESS_DISABLED_MSG =
    "Plugin code access has been disabled by the user for this platform (the \"Include plugin code\" checkbox is unchecked in the web app's Plugin Version section). " +
    "Don't attempt to read or search the code — answer using only what's already shared (API call, screenshots, version) or ask the user to re-enable it.";

  async function codeAccessAllowed(platform) {
    const ctx = await loadSharedContext(platform);
    return ctx?.includeCode !== false;
  }

  server.registerTool(
    "list_files",
    {
      description: "List all files in a downloaded plugin version.",
      inputSchema: { platform: platformParam, version: z.string().describe("Version tag, e.g. v6.0.0") },
    },
    async ({ platform, version }) => {
      if (!(await codeAccessAllowed(platform))) {
        return { content: [{ type: "text", text: CODE_ACCESS_DISABLED_MSG }] };
      }
      return { content: [{ type: "text", text: await doListFiles(platform, version) }] };
    }
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
    async ({ platform, version, path: relPath }) => {
      if (!(await codeAccessAllowed(platform))) {
        return { content: [{ type: "text", text: CODE_ACCESS_DISABLED_MSG }] };
      }
      return { content: [{ type: "text", text: await doReadFile(platform, version, relPath) }] };
    }
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
    async ({ platform, version, query }) => {
      if (!(await codeAccessAllowed(platform))) {
        return { content: [{ type: "text", text: CODE_ACCESS_DISABLED_MSG }] };
      }
      return { content: [{ type: "text", text: await doSearchCode(platform, version, query) }] };
    }
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

  server.registerTool(
    "get_notes",
    {
      description:
        "Get the free-text notes shared from the web app's Notes section for a given platform, via its \"Share with MCP\" button. " +
        "This is shared, not private to one person — it reflects whoever shared most recently.",
      inputSchema: { platform: platformParam },
    },
    async ({ platform }) => ({
      content: [{ type: "text", text: await doGetNotes(platform) }],
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
