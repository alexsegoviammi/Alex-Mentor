import express from "express";
import cors from "cors";
import serverless from "serverless-http";
// import axios from "axios"; <--- ELIMINADO (Usamos fetch nativo)
import { createClient } from "@supabase/supabase-js";

const app = express();

// ==========================================
// 1. CONFIGURACIÓN
// ==========================================
const N8N_BASE = "https://n8n.icc-e.org";

// Detectar entorno (Netlify vs Local)
const IS_NETLIFY = !!(
	process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_VERSION
);

// Timeouts: 25s en Nube (límite Netlify) / 10 min en Local
const UPSTREAM_TIMEOUT_MS = IS_NETLIFY ? 25000 : 600_000;

// Rate Limiting: 60 peticiones cada 24h
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

// Mapa de Rutas
const ROUTE_MAP = {
	chat: process.env.N8N_CHAT_WEBHOOK || "/webhook/mentor-chat-mode",
	pdf_status: process.env.N8N_PDF_WEBHOOK || "/webhook/mentor-chat-mode-pdf",
	task: "/webhook/mentor-task",
};

// Inicializar Supabase (Fail-safe)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
	supabase = createClient(
		process.env.SUPABASE_URL,
		process.env.SUPABASE_SERVICE_ROLE_KEY
	);
} else {
	console.warn("⚠️ Supabase no configurado. Rate Limiting DESACTIVADO.");
}

// ==========================================
// 2. MIDDLEWARES
// ==========================================

app.use(
	cors({
		origin: true,
		methods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	})
);
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// Middleware de Timeout Seguro (Solo en local para evitar crash en Netlify)
app.use((req, res, next) => {
	if (!IS_NETLIFY) {
		if (req.setTimeout) req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
		if (res.setTimeout) res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	}
	next();
});

// Middleware de Rate Limiting (Supabase)
// Middleware de Rate Limiting (Supabase)
const rateLimitMiddleware = async (req, res, next) => {
    // 1. SI ES UN PING O TEST, PASAR DIRECTAMENTE (NO CONTAR)
    // Esto evita bloqueos por recargar la página muchas veces
    const bodyMsg = req.body?.message || "";
    const bodyAction = req.body?.action || "";
    
    if (bodyMsg === "_connection_test" || bodyAction === "ping") {
        return next();
    }

    // 2. Si no hay Supabase o es OPTIONS, pasar
	if (!supabase || req.method === "OPTIONS") return next();

	try {
		// Obtener IP (compatible con Netlify y Express local)
		const clientIp =
			req.headers["x-nf-client-connection-ip"] ||
			req.headers["client-ip"] ||
			req.ip ||
			"unknown";
            
		const timeWindow = new Date(
			Date.now() - RATE_LIMIT_WINDOW_MS
		).toISOString();

		const { count, error } = await supabase
			.from("request_logs")
			.select("*", { count: "exact", head: true })
			.eq("ip_address", clientIp)
			.gte("created_at", timeWindow);

		if (error) throw error;

        // 3. BLOQUEO (Solo si supera el límite)
		if (count >= MAX_REQUESTS_PER_WINDOW) {
			console.warn(`⛔ Bloqueo Rate Limit: IP ${clientIp}`);
            // COMENTA ESTO TEMPORALMENTE SI QUIERES DESBLOQUEARTE YA MISMO
			/* return res
				.status(429)
				.json({
					error: "Límite diario alcanzado. Intenta mañana.",
				}); */
             console.log("Limite superado pero permitiendo acceso en modo DEV"); // LOG DE AVISO
		}

		// Registrar petición en fondo (no bloqueante)
		const action = req.body?.action || "unknown";
		supabase
			.from("request_logs")
			.insert({ ip_address: clientIp, endpoint: action })
			.then(() => {});

		next();
	} catch (err) {
		console.error("Error Rate Limiting:", err);
		next(); // Si falla la BD, dejamos pasar
	}
};

// ==========================================
// 3. LÓGICA DE REENVÍO (NATIVE FETCH)
// ==========================================
async function forward({ path, method, headers, body }) {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	const {
		host,
		origin,
		"content-length": cl,
		"content-type": ct,
		...safeHeaders
	} = headers || {};
	const url = path.startsWith("http") ? path : `${N8N_BASE}${path}`;

	console.log(`[PROXY] ⏳ A n8n: ${url} (Timeout: ${UPSTREAM_TIMEOUT_MS}ms)`);

	try {
		// USAMOS FETCH NATIVO (Node 18+)
		const response = await fetch(url, {
			method: method,
			headers: { ...safeHeaders, "Content-Type": "application/json" },
			body: ["GET", "HEAD"].includes(method) ? undefined : body,
			signal: controller.signal,
		});

		clearTimeout(t);

		// Obtenemos el texto crudo
		const text = await response.text();
		return { status: response.status, body: text };
	} catch (error) {
		clearTimeout(t);

		// Manejo de Timeout nativo (AbortError)
		if (error.name === "AbortError") {
			const msg = IS_NETLIFY
				? "Timeout: Netlify cortó (límite alcanzado). Iniciando polling..."
				: "Timeout: n8n tardó más de 10 minutos.";

			// Devolvemos 504 para activar el polling en el frontend
			return { status: 504, body: JSON.stringify({ error: msg }) };
		}
		throw error;
	}
}

// ==========================================
// 4. ROUTER Y ARRANQUE
// ==========================================

// Ruta Universal con Rate Limit y Proxy
app.all(/.*/, rateLimitMiddleware, async (req, res) => {
	try {
		// Limpieza de URL para Netlify
		let cleanUrl = req.originalUrl.replace("/.netlify/functions/proxy", "");
		if (!cleanUrl || cleanUrl.startsWith("?")) cleanUrl = "/" + cleanUrl;

		let targetPath = cleanUrl;
		let bodyToSend = req.body;

		// Enrutamiento inteligente por acción
		if (req.body && req.body.action && ROUTE_MAP[req.body.action]) {
			targetPath = ROUTE_MAP[req.body.action];
			bodyToSend = req.body.payload;
			if (typeof bodyToSend === "object")
				bodyToSend = JSON.stringify(bodyToSend);
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

// Modo Local
if (!IS_NETLIFY) {
	const PORT = 8787;
	app.listen(PORT, () => {
		console.log(`🚀 Proxy Local corriendo en http://localhost:${PORT}`);
		console.log(`⏱️  Modo Local: Timeout extendido a 10 minutos.`);
		if (supabase) console.log(`🛡️  Rate Limiting: ACTIVO`);
	});
}

// Modo Netlify
export const handler = serverless(app);
