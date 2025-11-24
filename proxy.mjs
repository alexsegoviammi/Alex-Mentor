import express from "express";
import cors from "cors";
import http from "http";
import "dotenv/config"; // Carga variables de .env

const app = express();

// ==== CONFIG ====
const N8N_BASE = "https://n8n.icc-e.org";             // tu n8n
const PORT = 8787;                                    // puerto local proxy
const UPSTREAM_TIMEOUT_MS = 300_000;                  // 5 min
// ================

// Inicializar Supabase
const supabase = createClient(
if (!process.env.N8N_CHAT_WEBHOOK || !process.env.N8N_PDF_WEBHOOK) {
  console.error("ERROR: Faltan variables de entorno críticas (N8N_CHAT_WEBHOOK, N8N_PDF_WEBHOOK).");
  process.exit(1);
}

// CORS para TODO el proxy
app.use(cors({
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// Body parsers (acepta JSON y texto plano)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "2mb" }));

// === NUEVO: CONFIGURACIÓN DE TIMEOUT DEL SOCKET ===
// Esto evita que Express corte la conexión a los 2 minutos por defecto
app.use((req, res, next) => {
	req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000); // 10 min + 5 seg de gracia
	res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	next();
});
// =================================================

// Mapa de rutas del proxy a webhooks de n8n
const routeMap = {
  "/webhook/chat": process.env.N8N_CHAT_WEBHOOK,
  "/webhook/status": process.env.N8N_PDF_WEBHOOK,
};

// Utilidad para reenviar la petición a n8n
async function forward({ targetUrl, method, headers, body }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // Limpia cabeceras que no deben reenviarse
  const { host, origin, referer, ...safeHeaders } = headers || {};

  const resp = await fetch(targetUrl, {
    method,
    headers: {
      ...safeHeaders,
      // n8n espera JSON
      "Content-Type": "application/json",
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  const text = await resp.text();
  return { status: resp.status, body: text, headers: resp.headers };
}

// Ruta genérica que usa el mapa para redirigir
app.all("/webhook/*", async (req, res) => {
  const targetUrl = routeMap[req.path];

  if (!targetUrl) {
    return res.status(404).send("Ruta no encontrada en el proxy.");
  }

  try {
    const upstream = await forward({
      targetUrl,
      method: req.method,
      headers: req.headers,
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body)
    });

    // Reenviar headers de n8n (como content-type)
    for (const [key, value] of upstream.headers.entries()) {
      res.setHeader(key, value);
    }
    res.status(upstream.status);
    res.send(upstream.body);
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "Proxy timeout (5 min) alcanzado"
      : `Proxy error: ${err?.message || err}`;
    res.status(504).send(JSON.stringify({ success: false, error: msg }));
  }
});

app.options(/^\/webhook\/(.*)/, (req, res) => res.status(204).end());

http.createServer(app).listen(PORT, () => {
	console.log(`🚀 Proxy corriendo en http://localhost:${PORT}`);
	console.log(
		`⏱️  Timeout configurado a: ${UPSTREAM_TIMEOUT_MS / 60000} minutos`
	);
});
