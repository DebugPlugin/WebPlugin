window.ApiTools = (function () {
  let lastResponse = null;

  function getLastResponse() {
    return lastResponse;
  }

  function reset() {
    lastResponse = null;
    document.querySelectorAll('[id^="response-box-"]').forEach((el) => el.classList.add("hidden"));
    document.querySelectorAll('[id^="status-badge-"]').forEach((el) => el.classList.add("hidden"));
    document.querySelectorAll('[id^="time-taken-"]').forEach((el) => el.classList.add("hidden"));
    document.querySelectorAll('[id^="btn-copy-"]').forEach((el) => el.classList.add("hidden"));
    document.querySelectorAll('[id^="response-code-"]').forEach((el) => (el.textContent = ""));
  }

  function normalizeUrl(raw) {
    return (raw || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  function basicAuth(user, pass) {
    return "Basic " + btoa(`${user}:${pass}`);
  }

  const SENSITIVE_HEADER = /authorization|token|key|secret/i;

  function redactHeaders(headers) {
    const out = {};
    Object.entries(headers || {}).forEach(([k, v]) => {
      out[k] = SENSITIVE_HEADER.test(k) ? "[redacted]" : v;
    });
    return out;
  }

  async function callProxy(url, { method = "GET", headers = {}, body } = {}) {
    const t0 = performance.now();
    const res = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, method, headers, body }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { ...data, elapsed: Math.round(performance.now() - t0) };
  }

  // Shopware 5's legacy /api/* is protected with HTTP Digest Auth — the server does the
  // two-round-trip handshake (401 challenge, then a computed Authorization header).
  async function callDigestProxy(url, { method = "GET", user, pass } = {}) {
    const t0 = performance.now();
    const res = await fetch("/api/proxy-digest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, method, user, pass }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { ...data, elapsed: Math.round(performance.now() - t0) };
  }

  function paramFieldHTML(ep, p) {
    if (p.type === "select") {
      const options = (p.options || [])
        .map((o) => `<option value="${o}" ${o === p.default ? "selected" : ""}>${o}</option>`)
        .join("");
      return `<select id="${ep.key}-${p.id}" class="param-input">${options}</select>`;
    }
    return `<input id="${ep.key}-${p.id}" class="param-input" type="${p.type || "text"}" value="${p.default ?? ""}" ${p.type === "number" ? 'min="1"' : ""} placeholder="${p.placeholder || ""}">`;
  }

  function accordionHTML(ep) {
    const paramsHtml = (ep.params || [])
      .map(
        (p) => `
      <div class="param-group">
        <label class="param-label" for="${ep.key}-${p.id}">${p.label}</label>
        ${paramFieldHTML(ep, p)}
      </div>`
      )
      .join("");

    return `
      <button class="accordion-header" data-target="body-${ep.key}" type="button">
        <span class="accordion-title">${ep.title}</span>
        <span class="accordion-chevron">▼</span>
      </button>
      <div id="body-${ep.key}" class="accordion-body">
        <div class="endpoint-path">${ep.method || "GET"} ${ep.pathLabel}</div>
        ${ep.hint ? `<p class="hint">${ep.hint}</p>` : ""}
        ${paramsHtml ? `<div class="params-row">${paramsHtml}</div>` : ""}
        <div class="action-row">
          <button id="btn-curl-${ep.key}" class="btn-curl" type="button">Copy cURL</button>
          <button id="btn-call-${ep.key}" class="btn-call" type="button">Call endpoint</button>
        </div>
        <div class="response-meta">
          <span id="status-badge-${ep.key}" class="status-badge hidden"></span>
          <span id="time-taken-${ep.key}" class="time-taken hidden"></span>
        </div>
        <div id="response-box-${ep.key}" class="response-box hidden">
          <pre><code id="response-code-${ep.key}"></code></pre>
        </div>
        <button id="btn-copy-${ep.key}" class="btn-copy hidden" type="button">Copy JSON</button>
      </div>
      <div class="divider"></div>`;
  }

  function mount(container, endpoints, getBaseUrl) {
    container.innerHTML = endpoints.map(accordionHTML).join("");

    container.querySelectorAll(".accordion-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.classList.toggle("open");
        document.getElementById(btn.dataset.target).classList.toggle("open");
      });
    });

    endpoints.forEach((ep) => {
      const btnCall = document.getElementById(`btn-call-${ep.key}`);
      const btnCurl = document.getElementById(`btn-curl-${ep.key}`);
      const btnCopy = document.getElementById(`btn-copy-${ep.key}`);
      const badge = document.getElementById(`status-badge-${ep.key}`);
      const time = document.getElementById(`time-taken-${ep.key}`);
      const box = document.getElementById(`response-box-${ep.key}`);
      const code = document.getElementById(`response-code-${ep.key}`);

      function paramValue(id) {
        const el = document.getElementById(`${ep.key}-${id}`);
        return el ? el.value.trim() : "";
      }

      btnCall.addEventListener("click", async () => {
        const baseUrl = getBaseUrl();
        if (!baseUrl) {
          alert("Enter the store URL first");
          return;
        }
        const { url, headers, method, body, digest } = ep.build(baseUrl, paramValue);
        btnCall.textContent = "Calling...";
        btnCall.disabled = true;
        badge.classList.add("hidden");
        time.classList.add("hidden");
        box.classList.add("hidden");
        btnCopy.classList.add("hidden");
        try {
          const res = digest
            ? await callDigestProxy(url, { method, user: digest.user, pass: digest.pass })
            : await callProxy(url, { method, headers, body });
          let pretty, raw;
          try {
            const parsed = JSON.parse(res.text);
            raw = JSON.stringify(parsed);
            pretty = JSON.stringify(parsed, null, 2);
          } catch {
            raw = res.text;
            pretty = res.text;
          }
          code.textContent = pretty;
          badge.textContent = res.status;
          badge.className = "status-badge " + (res.ok ? "ok" : "err");
          badge.classList.remove("hidden");
          time.textContent = `${res.elapsed} ms`;
          time.classList.remove("hidden");
          box.classList.remove("hidden");
          btnCopy.classList.remove("hidden");
          lastResponse = {
            title: ep.title,
            method: method || "GET",
            url,
            headers: digest ? { Authorization: "[redacted — Digest]" } : redactHeaders(headers),
            status: res.status,
            json: pretty,
          };
          btnCopy.onclick = () => {
            navigator.clipboard.writeText(raw).then(() => {
              btnCopy.textContent = "✓ Copied!";
              setTimeout(() => {
                btnCopy.textContent = "Copy JSON";
              }, 1500);
            });
          };
        } catch (err) {
          code.textContent = "Error: " + err.message;
          badge.textContent = "Error";
          badge.className = "status-badge err";
          badge.classList.remove("hidden");
          box.classList.remove("hidden");
        } finally {
          btnCall.textContent = "Call endpoint";
          btnCall.disabled = false;
        }
      });

      btnCurl.addEventListener("click", () => {
        const baseUrl = getBaseUrl();
        if (!baseUrl) {
          alert("Enter the store URL first");
          return;
        }
        const { url, headers, method, body, digest } = ep.build(baseUrl, paramValue);
        let cmd;
        if (digest) {
          cmd = `curl --location --globoff --digest -u '${digest.user}:${digest.pass}' '${url}'`;
          if (method && method !== "GET") cmd += ` \\\n  --request ${method}`;
        } else {
          const headerLines = Object.entries(headers || {})
            .map(([k, v]) => `  --header '${k}: ${v}'`)
            .join(" \\\n");
          cmd = `curl --location --globoff '${url}'`;
          if (method && method !== "GET") cmd += ` \\\n  --request ${method}`;
          if (headerLines) cmd += ` \\\n${headerLines}`;
          if (body) cmd += ` \\\n  --data '${body}'`;
        }
        navigator.clipboard.writeText(cmd).then(() => {
          const orig = btnCurl.textContent;
          btnCurl.textContent = "✓ Copied!";
          setTimeout(() => {
            btnCurl.textContent = orig;
          }, 1500);
        });
      });
    });
  }

  return { normalizeUrl, basicAuth, callProxy, mount, getLastResponse, reset };
})();
