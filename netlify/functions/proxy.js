import express from "express";
import cors from "cors";
import serverless from "serverless-http";

const app = express();

// ==== CONFIGURACIÓN DINÁMICA ====
const N8N_BASE = "https://n8n.icc-e.org";

// Detectamos si estamos en Netlify o en Local
const IS_NETLIFY = !!(
	process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_VERSION
);

// Tiempo de espera: 25 segundos en Nube / 10 Minutos en Local
const UPSTREAM_TIMEOUT_MS = IS_NETLIFY ? 25000 : 600_000;

const ROUTE_MAP = {
	chat: "/webhook/mentor-chat-mode",
	pdf_status: "/webhook/mentor-chat-mode-pdf",
	task: "/webhook/mentor-task",
};
// ================================

app.use(
	cors({
		origin: true,
		methods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	})
);
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// --- MIDDLEWARE DE TIMEOUT (CORREGIDO PARA NETLIFY) ---
app.use((req, res, next) => {
	// CRÍTICO: En Netlify (Serverless) NO podemos tocar el timeout del socket porque no existe.
	// Solo aplicamos esto si estamos corriendo en Local (Node.js tradicional).
	if (!IS_NETLIFY) {
		if (req.setTimeout) req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
		if (res.setTimeout) res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	}
	next();
});
// -----------------------------------------------------

async function forward({ path, method, headers, body }) {
	// Timeout interno para cortar la petición si n8n se cuelga
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	const {
		host,
		origin,
		"content-length": cl,
		"content-type": ct,
		...safeHeaders
	} = headers || {};

	const url = `${N8N_BASE}${path}`;
	console.log(`[PROXY] ⏳ A n8n: ${url} (Timeout: ${UPSTREAM_TIMEOUT_MS}ms)`);

	try {
		const resp = await fetch(url, {
			method,
			headers: { ...safeHeaders, "Content-Type": "application/json" },
			body: ["GET", "HEAD"].includes(method) ? undefined : body,
			signal: controller.signal,
		}).finally(() => clearTimeout(t));

		const text = await resp.text();
		return { status: resp.status, body: text };
	} catch (error) {
		if (error.name === "AbortError") {
			const msg = IS_NETLIFY
				? "Timeout: Netlify cortó (límite alcanzado). Iniciando polling..."
				: "Timeout: n8n tardó más de 10 minutos.";

			return {
				status: 504,
				body: JSON.stringify({ error: msg }),
			};
		}
		throw error;
	}
}

// Ruta Universal
app.all(/.*/, async (req, res) => {
	try {
		// 1. Limpieza de URL
		let cleanUrl = req.originalUrl.replace("/.netlify/functions/proxy", "");
		if (!cleanUrl || cleanUrl.startsWith("?")) {
			cleanUrl = "/" + cleanUrl;
		}

		// 2. Enrutamiento
		let targetPath = cleanUrl;
		let bodyToSend = req.body;

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

// ==== MODO LOCAL (Se activa solo en tu PC) ====
if (!IS_NETLIFY) {
	const PORT = 8787;
	app.listen(PORT, () => {
		console.log(`🚀 Proxy Local corriendo en http://localhost:${PORT}`);
		console.log(`⏱️  Modo Local: Timeout extendido a 10 minutos.`);
	});
}

export const handler = serverless(app);
