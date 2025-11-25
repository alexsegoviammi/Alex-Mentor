import express from "express";
import cors from "cors";
import serverless from "serverless-http";

const app = express();

// ==== CONFIG ====
const N8N_BASE = "https://n8n.icc-e.org";
// Nota: En Netlify Free el límite real es 10 segundos.
// El polling en el frontend es el que nos salvará si tarda más.
const UPSTREAM_TIMEOUT_MS = 25000;

const ROUTE_MAP = {
	chat: "/webhook/mentor-chat-mode",
	pdf_status: "/webhook/mentor-chat-mode-pdf",
	task: "/webhook/mentor-task",
};
// ================

app.use(
	cors({
		origin: true,
		methods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	})
);
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// --- ELIMINADO: Middleware de req.setTimeout que causaba el Error 500 ---

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
	console.log(`[PROXY] ⏳ A n8n: ${url}`);

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
			return {
				status: 504,
				body: JSON.stringify({
					error: "Timeout: Netlify cortó la conexión (límite 10s/26s).",
				}),
			};
		}
		throw error;
	}
}

// Ruta Universal con Regex corregido
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

export const handler = serverless(app);
