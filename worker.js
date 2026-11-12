// worker.js, Cloudflare Worker
// Rutas: /?url=https://sitio.com   y   /p/https%3A%2F%2Fsitio.com

const BLOCKED_HEADERS = [
 "content-security-policy",
 "content-security-policy-report-only",
  "x-frame-options",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy"
];

const ATTR_RE = /(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])([\s\S]*?)\2/gi;
const CSSURL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

function proxify(value, base, origin) {
  const val = String(value || "").trim();
  if (!val) return value;
  if (/^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(val)) return value;
  try {
    const abs = new URL(val, base);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return value;
    return origin + "/p/" + abs.href;
  } catch (e) {
    return value;
  }
}

function rewriteHtml(html, base, origin) {
  let out = html.replace(ATTR_RE, (m, pre, q, val) => {
    return pre + q + proxify(val, base, origin) + q;
  });

  out = out.replace(CSSURL_RE, (m, q, val) => {
   if (/^(data:|#)/i.test(val)) return m;
    return "url(" + q + proxify(val, base, origin) + q + ")";
  });

  out = out.replace(/(\ssrcset\s*=\s*)(["'])([\s\S]*?)\2/gi, (m, pre, q, val) => {
    const parts = val.split(",").map((chunk) => {
      const bits = chunk.trim().split(/\s+/);
      if (!bits[0]) return chunk;
     bits[0] = proxify(bits[0], base, origin);
      return bits.join(" ");
    });
    return pre + q + parts.join(", ") + q;
  });

  return out;
}

function corsHeaders() {
  return {
   "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS"
  };
}

const LANDING = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Marcus</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;
color:#e8edf4;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px}
code{background:#151a21;border:1px solid #232a34;border-radius:8px;padding:2px 7px;color:#6ea8fe}
p{color:#8b98a8;max-width:460px}</style></head><body><div>
<h2>Marcus está despierto</h2>
<p>Pásale una dirección así: <code>/?url=https://example.com</code></p>
</div></body></html>`;

export default {
 async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
     return new Response(null, { headers: corsHeaders() });
    }

   let target = url.searchParams.get("url");

    if (!target && url.pathname.startsWith("/p/")) {
      const rest = url.pathname.slice(3);
      try {
        target = decodeURIComponent(rest);
      } catch (e) {
        target = rest;
      }
      if (url.search) target += url.search;
    }

    if (!target) {
      return new Response(LANDING, {
        headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders() }
     });
    }

    let targetUrl;
    try {
     targetUrl = new URL(target);
      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        throw new Error("protocolo no permitido");
     }
    } catch (e) {
      return new Response("Dirección no válida", { status: 400, headers: corsHeaders() });
   }

    const upstreamHeaders = new Headers();
    upstreamHeaders.set("user-agent", request.headers.get("user-agent") || "Mozilla/5.0");
    upstreamHeaders.set("accept", request.headers.get("accept") || "text/html,application/xhtml+xml,*/*;q=0.8");
    upstreamHeaders.set("accept-language", request.headers.get("accept-language") || "es-ES,es;q=0.9,en;q=0.8");

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders,
        redirect: "follow"
     });
    } catch (e) {
      return new Response("No se pudo cargar el sitio: " + e.message, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders() }
      });
    }

    const finalUrl = upstream.url || targetUrl.toString();
    const origin = url.origin;
    const type = (upstream.headers.get("content-type") || "").toLowerCase();

    const headers = new Headers(upstream.headers);
    BLOCKED_HEADERS.forEach((h) => headers.delete(h));
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.delete("strict-transport-security");
    headers.delete("report-to");
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

    if (type.includes("text/html")) {
     const body = await upstream.text();
      return new Response(rewriteHtml(body, finalUrl, origin), {
        status: upstream.status,
        headers
     });
    }

    if (type.includes("text/css")) {
      const body = await upstream.text();
      const fixed = body.replace(CSSURL_RE, (m, q, val) => {
       if (/^(data:|#)/i.test(val)) return m;
        return "url(" + q + proxify(val, finalUrl, origin) + q + ")";
      });
      return new Response(fixed, { status: upstream.status, headers });
   }

    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
