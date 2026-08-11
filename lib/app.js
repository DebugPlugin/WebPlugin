const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const AdmZip = require("adm-zip");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const Anthropic = require("@anthropic-ai/sdk");

const REPO = "doofinder/doofinder-prestashop";
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

async function listReleases() {
  return githubRequest(`/repos/${REPO}/releases`);
}

async function downloadRelease(tag) {
  const targetDir = path.join(REPOS_DIR, tag);
  if (fs.existsSync(targetDir)) return targetDir;

  const releases = await listReleases();
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) throw new Error(`Release ${tag} not found`);

  const zipUrl = release.zipball_url;
  const zipPath = path.join(REPOS_DIR, `${tag}.zip`);
  await downloadFile(zipUrl, zipPath);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const rootFolder = entries[0].entryName.split("/")[0];
  zip.extractAllTo(REPOS_DIR, true);
  fs.renameSync(path.join(REPOS_DIR, rootFolder), targetDir);
  fs.unlinkSync(zipPath);

  return targetDir;
}

function listLocalVersions() {
  return fs.readdirSync(REPOS_DIR).filter((f) => fs.statSync(path.join(REPOS_DIR, f)).isDirectory());
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

async function ensureVersionDir(version) {
  const dir = path.join(REPOS_DIR, version);
  if (fs.existsSync(dir)) return dir;
  // En Vercel cada invocacion puede caer en una instancia distinta con su propio
  // /tmp: si esta version no esta en ESTA instancia, la descargamos de nuevo.
  return downloadRelease(version);
}

function safeFilePath(versionDir, relPath) {
  const full = path.resolve(versionDir, relPath);
  if (!full.startsWith(path.resolve(versionDir))) throw new Error("Invalid path");
  return full;
}

// ---------- Web UI + REST API ----------

const SITE_USER = process.env.SITE_USER || "admin";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";

const app = express();

if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const sep = decoded.indexOf(":");
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (user === SITE_USER && pass === SITE_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="DooPresta"');
    res.status(401).send("Authentication required");
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/releases", async (req, res) => {
  try {
    const releases = await listReleases();
    const downloaded = new Set(listLocalVersions());
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

app.post("/api/download", async (req, res) => {
  try {
    const { tag } = req.body;
    const dir = await downloadRelease(tag);
    res.json({ ok: true, path: dir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/local", (req, res) => {
  res.json(listLocalVersions());
});

// ---------- Shared plugin-inspection tools (used by both MCP and the web chat) ----------

function doListVersions() {
  return JSON.stringify(listLocalVersions());
}

async function doListFiles(version) {
  const dir = await ensureVersionDir(version);
  return JSON.stringify(walkFiles(dir));
}

async function doReadFile(version, relPath) {
  const dir = await ensureVersionDir(version);
  const full = safeFilePath(dir, relPath);
  return fs.readFileSync(full, "utf-8");
}

async function doSearchCode(version, query) {
  const dir = await ensureVersionDir(version);
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

// ---------- MCP server ----------

function buildMcpServer() {
  const server = new McpServer({ name: "doopresta", version: "1.0.0" });

  server.registerTool(
    "list_versions",
    {
      description: "List plugin versions already downloaded locally and available to query.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: doListVersions() }],
    })
  );

  server.registerTool(
    "list_files",
    {
      description: "List all files in a downloaded plugin version.",
      inputSchema: { version: z.string().describe("Version tag, e.g. 6.0.0") },
    },
    async ({ version }) => ({
      content: [{ type: "text", text: await doListFiles(version) }],
    })
  );

  server.registerTool(
    "read_file",
    {
      description: "Read the full contents of one file from a downloaded plugin version.",
      inputSchema: {
        version: z.string(),
        path: z.string().describe("File path relative to the plugin root, from list_files"),
      },
    },
    async ({ version, path: relPath }) => ({
      content: [{ type: "text", text: await doReadFile(version, relPath) }],
    })
  );

  server.registerTool(
    "search_code",
    {
      description: "Search for a text string across all files of a downloaded plugin version. Returns matching file paths with line numbers and the matching line.",
      inputSchema: {
        version: z.string(),
        query: z.string().describe("Text or keyword to search for (case-insensitive)"),
      },
    },
    async ({ version, query }) => ({
      content: [{ type: "text", text: await doSearchCode(version, query) }],
    })
  );

  return server;
}

app.post("/mcp", async (req, res) => {
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
    description: "List plugin versions already downloaded locally and available to query.",
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

async function runChatTool(name, input) {
  switch (name) {
    case "list_versions":
      return doListVersions();
    case "list_files":
      return doListFiles(input.version);
    case "read_file":
      return doReadFile(input.version, input.path);
    case "search_code":
      return doSearchCode(input.version, input.query);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const CHAT_SYSTEM_PROMPT =
  "Sei un assistente integrato in una web app per esplorare il codice sorgente del plugin PrestaShop di Doofinder. " +
  "L'utente ha già scaricato alcune versioni del plugin tramite l'interfaccia web dell'app. " +
  "Usa gli strumenti disponibili per ispezionare il codice scaricato e rispondi in modo preciso, citando percorsi di file e numeri di riga quando è utile. " +
  "Se l'utente chiede di una versione non ancora scaricata, digli di scaricarla prima dalla pagina web.";

app.post("/api/chat", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata sul server." });
  }
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages richiesto" });
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    let reply = "";
    for (let i = 0; i < 8; i++) {
      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 4096,
        system: CHAT_SYSTEM_PROMPT,
        tools: CHAT_TOOLS,
        messages: convo,
      });

      if (response.stop_reason === "refusal") {
        reply = "Il modello ha rifiutato di rispondere a questa richiesta.";
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
            return { type: "tool_result", tool_use_id: tu.id, content: await runChatTool(tu.name, tu.input) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: tu.id, content: e.message, is_error: true };
          }
        })
      );
      convo.push({ role: "user", content: toolResults });

      if (i === 7) reply = text || "Non sono riuscito a completare la richiesta.";
    }

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
