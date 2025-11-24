// proxy.mjs
import express from "express";
import cors from "cors";
import http from "http";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config"; // Carga variables de .env

const app = express();

// ==== CONFIG ====
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "https://alex-mentor.netlify.app/";
const N8N_BASE = process.env.N8N_BASE || "https://n8n.icc-e.org";
const PORT = process.env.PORT || 8787;
const UPSTREAM_TIMEOUT_MS = 300_000; // 5 min

// URLs de webhooks de n8n desde variables de entorno
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK;
const N8N_PDF_WEBHOOK = process.env.N8N_PDF_WEBHOOK;

// ==== CONFIGURACIÓN DE LÍMITES ESTRICTA ====
// Teóricamente, con esta configuración debería permitir 1 solo Plan de Negocio por IP cada 24 horas.
// Cálculo "Tentativo": 7 pasos chat + 20 poleos PDF + 5 margen error = unas 32 requests.
// Queda en 60 para dar margen a preguntas extra, pero bloqueamos intentos masivos.
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // Ventana de 24 horas
const MAX_REQUESTS_PER_WINDOW = 60; // Límite de interacciones por día
// ================

// Inicializar Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!process.env.SUPABASE_URL || !process.env.N8N_CHAT_WEBHOOK || !process.env.N8N_PDF_WEBHOOK) {
  console.error("ERROR: Faltan variables de entorno críticas (SUPABASE_URL, N8N_CHAT_WEBHOOK, N8N_PDF_WEBHOOK).");
  process.exit(1);
}

// CORS para TODO el proxy
app.use(cors({
  origin: FRONT_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// Body parsers (acepta JSON y texto plano)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "2mb" }));

app.set('trust proxy', true); // Necesario para obtener la IP correcta detrás de un proxy (como Netlify)

// Mantener sockets abiertos lo suficiente
app.use((req, res, next) => {
  req.setTimeout(UPSTREAM_TIMEOUT_MS + 10_000);
  res.setTimeout(UPSTREAM_TIMEOUT_MS + 10_000);
  next();
});

// Utilidad para reenviar la petición a n8n con fetch y abort a los 5 min
async function forward({ url, method, headers, body }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // Limpia cabeceras que no deben reenviarse
  const { host, origin, referer, ...safeHeaders } = headers || {};

  // const url = `${N8N_BASE}${path}`; // Ya no se usa N8N_BASE directamente
  const resp = await fetch(url, {
    method,
    headers: {
      ...safeHeaders,
      // si el front envía text/plain, aquí lo normalizamos a JSON si procede
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  const text = await resp.text();
  return { status: resp.status, body: text, headers: resp.headers };
}

// Middleware de Rate Limiting con Supabase
const rateLimiter = async (req, res, next) => {
  // Solo aplicamos el límite a peticiones POST con cuerpo JSON
  if (req.method !== 'POST' || !req.body.action) {
    return next();
  }

  const clientIp = req.ip || 'unknown';

  try {
    const timeWindow = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    // Contamos cuántas veces ha hablado esta IP en las últimas 24hs
    const { count, error } = await supabase
      .from('request_logs')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', clientIp)
      .gte('created_at', timeWindow);

    if (error) throw error;

    // SI HA SUPERADO EL LÍMITE (Ya hizo su plan del día)
    if (count >= MAX_REQUESTS_PER_WINDOW) {
      console.warn(`IP Bloqueada por límite diario: ${clientIp}`);
      return res.status(429).json({
        // Este mensaje se mostrará en rojo en el chat
        error: 'Has alcanzado el límite diario de uso gratuito (1 Plan/día). Por favor, intenta nuevamente mañana.'
      });
    }

    // Si pasa, registramos y continuamos
    await supabase.from('request_logs').insert({
      ip_address: clientIp,
      endpoint: req.body.action || 'unknown'
    });

    next();

  } catch (err) {
    console.error('Error en middleware de Rate Limit (Supabase):', err);
    // Fail open: Si falla la DB, dejamos pasar para no tirar el servicio (opcional)
    next();
  }
};

// Ruta principal que ahora usa el rate limiter y enruta a n8n
app.post("/webhook/*", rateLimiter, async (req, res) => {
  // 1. ENRUTAMIENTO
  let targetUrl = '';
  const body = req.body; // Ya parseado por express.json()

  if (body.action === 'chat') {
    targetUrl = N8N_CHAT_WEBHOOK;
  } else if (body.action === 'pdf_status') {
    targetUrl = N8N_PDF_WEBHOOK;
  } else {
    // Si la acción no es válida, pero pasó el rate limiter, podría ser un GET u otro método
    // que no manejamos aquí. Devolvemos un error.
    return res.status(400).json({ error: 'Acción no válida' });
  }

  // 2. PROXY A N8N
  try {
    const upstream = await forward({
      url: targetUrl,
      method: req.method,
      headers: { ...req.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body.payload) // Reenviamos solo el payload
    });

    // Respuesta al navegador + CORS
    // Copiamos las cabeceras de la respuesta de n8n si es necesario
    // Por ahora, devolvemos una respuesta JSON simple
    res.status(upstream.status);
    res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.set("Cache-Control", "no-store");
    res.send(upstream.body);
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "Proxy timeout (5 min) alcanzado"
      : `Proxy error: ${err?.message || err}`;
    res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
    res.status(504).json({ success: false, error: msg });
  }
});

// Responder explícitamente a OPTIONS (preflight)
app.options("/webhook/*", (req, res) => {
  res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

// Arranque
http.createServer(app).listen(PORT, () => {
  console.log(`Proxy CORS listo en http://localhost:${PORT}`);
  console.log(`Reenviando hacia ${N8N_BASE}`);
});
