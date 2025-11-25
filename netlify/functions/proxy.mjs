import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ==========================================
// 1. CONFIGURACIÓN GENERAL
// ==========================================
const N8N_BASE = "https://n8n.icc-e.org";

// Detectamos entorno
const IS_NETLIFY = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_VERSION);

// Timeouts: 25s en Nube (límite Netlify) / 10 min en Local
const UPSTREAM_TIMEOUT_MS = IS_NETLIFY ? 25000 : 600_000;

// Configuración Rate Limit (60 peticiones / 24h)
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

// Mapa de Rutas
const ROUTE_MAP = {
    chat: process.env.N8N_CHAT_WEBHOOK || "/webhook/mentor-chat-mode",
    pdf_status: process.env.N8N_PDF_WEBHOOK || "/webhook/mentor-chat-mode-pdf",
    task: "/webhook/mentor-task",
};

// Inicializar Supabase (Fail-safe: si faltan claves, no explota, solo avisa)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} else {
    console.warn("⚠️ Supabase no configurado. El Rate Limiting estará desactivado.");
}

// ==========================================
// 2. MIDDLEWARES
// ==========================================

// CORS y Parsing
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// Middleware de Timeout (Solo aplica en Local para evitar crash en Netlify)
app.use((req, res, next) => {
    if (!IS_NETLIFY) {
        if (req.setTimeout) req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
        if (res.setTimeout) res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
    }
    next();
});

// Middleware de Rate Limiting (Lógica de Supabase adaptada a Express)
const rateLimitMiddleware = async (req, res, next) => {
    // Si no hay Supabase o es una petición OPTIONS, pasamos
    if (!supabase || req.method === "OPTIONS") return next();

    try {
        // Obtener IP real (soporta Netlify y Local)
        const clientIp = req.headers["x-nf-client-connection-ip"] || req.headers["client-ip"] || req.ip || "unknown";
        
        // Definir ventana de tiempo
        const timeWindow = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

        // Consultar conteo
        const { count, error } = await supabase
            .from("request_logs")
            .select("*", { count: "exact", head: true })
            .eq("ip_address", clientIp)
            .gte("created_at", timeWindow);

        if (error) throw error;

        // Bloquear si excede
        if (count >= MAX_REQUESTS_PER_WINDOW) {
            console.warn(`⛔ Bloqueo Rate Limit: IP ${clientIp}`);
            return res.status(429).json({ 
                error: "Has alcanzado el límite diario de uso (1 Plan/día). Por favor intenta mañana." 
            });
        }

        // Registrar petición (async, no bloqueamos el flujo principal)
        const action = req.body?.action || "unknown";
        supabase.from("request_logs").insert({ ip_address: clientIp, endpoint: action }).then(() => {});

        next();
    } catch (err) {
        console.error("Error Rate Limiting:", err);
        next(); // Fail-open: Si falla la BD, dejamos pasar al usuario
    }
};

// ==========================================
// 3. LÓGICA DE PROXY (Forwarder con AXIOS)
// ==========================================
async function forward({ path, method, headers, body }) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const { host, origin, "content-length": cl, "content-type": ct, ...safeHeaders } = headers || {};
    
    // Construir URL destino (Soporta ruta relativa o absoluta si viene de env var)
    const url = path.startsWith("http") ? path : `${N8N_BASE}${path}`;
    
    console.log(`[PROXY] ⏳ A n8n: ${url} (Timeout: ${UPSTREAM_TIMEOUT_MS}ms)`);

    try {
        const response = await axios({
            method: method,
            url: url,
            headers: { ...safeHeaders, "Content-Type": "application/json" },
            data: ["GET", "HEAD"].includes(method) ? undefined : body,
            signal: controller.signal,
            validateStatus: () => true, // No lanzar error en 404/500
            responseType: 'text',
            transformResponse: [(data) => data] 
        });

        clearTimeout(t);
        return { status: response.status, body: response.data };

    } catch (error) {
        clearTimeout(t);
        
        if (axios.isCancel(error) || error.code === 'ECONNABORTED' || error.name === "CanceledError") {
            const msg = IS_NETLIFY 
                ? "Timeout: Netlify cortó (límite alcanzado). Iniciando polling..." 
                : "Timeout: n8n tardó más de 10 minutos.";
            
            return { status: 504, body: JSON.stringify({ error: msg }) };
        }
        throw error;
    }
}

// ==========================================
// 4. ROUTER PRINCIPAL
// ==========================================
app.all(/.*/, rateLimitMiddleware, async (req, res) => {
    try {
        // Limpieza de URL para Netlify
        let cleanUrl = req.originalUrl.replace("/.netlify/functions/proxy", "");
        if (!cleanUrl || cleanUrl.startsWith("?")) cleanUrl = "/" + cleanUrl;

        let targetPath = cleanUrl;
        let bodyToSend = req.body;

        // Lógica de Enrutamiento por Acción
        if (req.body && req.body.action && ROUTE_MAP[req.body.action]) {
            targetPath = ROUTE_MAP[req.body.action];
            bodyToSend = req.body.payload;
            if (typeof bodyToSend === "object") {
                bodyToSend = JSON.stringify(bodyToSend);
            }
        }

        const upstream = await forward({
            path: targetPath,
            method: req.method,
            headers: req.headers,
            body: bodyToSend,
        });

        res.status(upstream.status).send(upstream.body);

    } catch (err) {
        console.error("[PROXY ERROR]", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. ARRANQUE (Híbrido)
// ==========================================

// Modo Local (Server tradicional)
if (!IS_NETLIFY) {
    const PORT = 8787;
    app.listen(PORT, () => {
        console.log(`🚀 Proxy Local corriendo en http://localhost:${PORT}`);
        console.log(`⏱️  Modo Local: Timeout extendido a 10 minutos.`);
        if (supabase) console.log(`🛡️  Rate Limiting: ACTIVO`);
        else console.log(`⚠️  Rate Limiting: INACTIVO (Faltan credenciales)`);
    });
}

// Modo Netlify (Export handler)
export const handler = serverless(app);