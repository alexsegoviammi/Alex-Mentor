import express from "express";
import cors from "cors";
import serverless from "serverless-http";

const app = express();

// ==== CONFIG ====
const N8N_BASE = "https://n8n.icc-e.org";
const UPSTREAM_TIMEOUT_MS = 600_000; // 10 Minutos

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

// Middleware de Timeout
app.use((req, res, next) => {
	req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	next();
});

async function forward({ path, method, headers, body }) {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	// Limpiamos headers
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
				body: JSON.stringify({ error: "Timeout: Espera agotada (10 min)" }),
			};
		}
		throw error;
	}
}

// === CORRECCIÓN AQUÍ: Usamos Regex /.*/ en lugar de "*" ===
app.all(/.*/, async (req, res) => {
	try {
		// 1. Limpieza de URL para Netlify
		const cleanUrl = req.originalUrl.replace("/.netlify/functions/proxy", "");

		// 2. Lógica de enrutamiento
		let targetPath = cleanUrl;
		let bodyToSend = req.body;

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

// ==== LA MAGIA HÍBRIDA ====
// Si NO estamos en Netlify, levantamos el servidor normal
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_VERSION) {
	const PORT = 8787;
	app.listen(PORT, () => {
		console.log(`🚀 Proxy Local corriendo en http://localhost:${PORT}`);
		console.log(`⏱️  Timeout: ${UPSTREAM_TIMEOUT_MS / 60000} min`);
	});
}

export const handler = serverless(app);
