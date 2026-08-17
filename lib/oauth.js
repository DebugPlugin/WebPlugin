const express = require("express");
const crypto = require("crypto");

// Minimal, self-contained OAuth 2.0 Authorization Server (RFC 6749 + PKCE + RFC 7591
// dynamic client registration), just enough for claude.ai's remote MCP connector UI,
// which only knows how to authenticate via OAuth (no Basic Auth support in that UI).
//
// Stateless by design (no DB, no in-memory session store) because Vercel serverless
// instances are ephemeral and not shared: every "token" (client_id, authorization code,
// access token, refresh token) is a signed blob that carries its own payload, verified
// with an HMAC secret shared via env var across all instances.

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

function verify(secret, token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function pkceMatches(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false;
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  return b64url(hash) === codeChallenge;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function loginForm({ action, hidden, error }) {
  const hiddenInputs = Object.entries(hidden)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>DPE MCP — Iniciar sesión</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15);width:300px}
h1{font-size:1.1rem;margin:0 0 1rem}
input[type=text],input[type=password]{width:100%;padding:.5rem;margin-bottom:.75rem;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
button{width:100%;padding:.5rem;background:#111;color:#fff;border:none;border-radius:4px;cursor:pointer}
.error{color:#b00020;font-size:.85rem;margin-bottom:.75rem}
</style></head>
<body>
<form method="post" action="${escapeHtml(action)}">
<h1>Conectar DPE</h1>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
${hiddenInputs}
<input type="text" name="username" placeholder="Usuario" autofocus required>
<input type="password" name="password" placeholder="Contraseña" required>
<button type="submit">Conectar</button>
</form>
</body></html>`;
}

// opts: { secret, siteUser, sitePassword }
function createOAuthRouter(opts) {
  const { secret, siteUser, sitePassword } = opts;
  const router = express.Router();

  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  router.get("/.well-known/oauth-protected-resource", (req, res) => {
    const b = baseUrl(req);
    res.json({ resource: `${b}/mcp`, authorization_servers: [b] });
  });

  router.post("/register", express.json(), (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
    if (redirectUris.length === 0) {
      return res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    }
    const iat = Math.floor(Date.now() / 1000);
    const clientId = sign(secret, { typ: "client", redirect_uris: redirectUris, name: body.client_name, iat });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: iat,
      redirect_uris: redirectUris,
      client_name: body.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  function handleAuthorize(req, res) {
    const q = { ...req.query, ...req.body };
    const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = q;

    const client = verify(secret, client_id);
    if (!client || client.typ !== "client") {
      return res.status(400).send("Invalid or unknown client_id. Try reconnecting the connector from scratch.");
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri does not match the one registered for this client.");
    }
    if (response_type !== "code") {
      return res.redirect(`${redirect_uri}?error=unsupported_response_type&state=${encodeURIComponent(state || "")}`);
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      return res.redirect(`${redirect_uri}?error=invalid_request&state=${encodeURIComponent(state || "")}`);
    }

    const hidden = { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope };

    if (req.method === "GET") {
      return res.send(loginForm({ action: "/authorize", hidden }));
    }

    // POST: form submission with username/password
    const { username, password } = req.body || {};
    const ok = sitePassword ? username === siteUser && password === sitePassword : true;
    if (!ok) {
      return res.status(401).send(loginForm({ action: "/authorize", hidden, error: "Usuario o contraseña incorrectos." }));
    }

    const code = sign(secret, {
      typ: "code",
      client_id,
      redirect_uri,
      code_challenge,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    res.redirect(`${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || "")}`);
  }

  router.get("/authorize", handleAuthorize);
  router.post("/authorize", express.urlencoded({ extended: true }), handleAuthorize);

  router.post("/token", express.urlencoded({ extended: true }), express.json(), (req, res) => {
    const body = req.body || {};
    const now = Math.floor(Date.now() / 1000);

    function issueTokens() {
      const access_token = sign(secret, { typ: "access", exp: now + 60 * 60 });
      const refresh_token = sign(secret, { typ: "refresh", exp: now + 60 * 60 * 24 * 180 });
      return { access_token, token_type: "Bearer", expires_in: 3600, refresh_token };
    }

    if (body.grant_type === "authorization_code") {
      const codePayload = verify(secret, body.code);
      if (!codePayload || codePayload.typ !== "code") {
        return res.status(400).json({ error: "invalid_grant", error_description: "Code is invalid or expired." });
      }
      if (codePayload.redirect_uri !== body.redirect_uri) {
        return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
      }
      if (!pkceMatches(body.code_verifier, codePayload.code_challenge)) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      }
      return res.json(issueTokens());
    }

    if (body.grant_type === "refresh_token") {
      const refreshPayload = verify(secret, body.refresh_token);
      if (!refreshPayload || refreshPayload.typ !== "refresh") {
        return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." });
      }
      return res.json(issueTokens());
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}

function verifyAccessToken(secret, authorizationHeader) {
  const [scheme, token] = (authorizationHeader || "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  const payload = verify(secret, token);
  if (!payload || payload.typ !== "access") return null;
  return payload;
}

module.exports = { createOAuthRouter, verifyAccessToken, sign, verify };
