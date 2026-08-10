const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const AdmZip = require("adm-zip");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const REPO = "doofinder/doofinder-prestashop";
// En Vercel el bundle del proyecto es de solo lectura: los releases descargados
// se cachean en /tmp (efímero, puede vaciarse entre invocaciones). En local se
// usa la carpeta repos/ del proyecto para no perder la caché entre reinicios.
const REPOS_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "doopresta-repos") : path.join(__dirname, "..", "repos");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

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

function safeVersionDir(version) {
  const dir = path.join(REPOS_DIR, version);
  if (!fs.existsSync(dir)) throw new Error(`Version "${version}" not downloaded yet`);
  return dir;
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
      content: [{ type: "text", text: JSON.stringify(listLocalVersions()) }],
    })
  );

  server.registerTool(
    "list_files",
    {
      description: "List all files in a downloaded plugin version.",
      inputSchema: { version: z.string().describe("Version tag, e.g. 6.0.0") },
    },
    async ({ version }) => {
      const dir = safeVersionDir(version);
      return { content: [{ type: "text", text: JSON.stringify(walkFiles(dir)) }] };
    }
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
    async ({ version, path: relPath }) => {
      const dir = safeVersionDir(version);
      const full = safeFilePath(dir, relPath);
      const text = fs.readFileSync(full, "utf-8");
      return { content: [{ type: "text", text }] };
    }
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
    async ({ version, query }) => {
      const dir = safeVersionDir(version);
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
      return { content: [{ type: "text", text: matches.slice(0, 200).join("\n") || "No matches." }] };
    }
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

module.exports = app;
