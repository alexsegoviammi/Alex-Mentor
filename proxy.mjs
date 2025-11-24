import express from "express";
import cors from "cors";
import http from "http";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config"; // Carga variables de .env

const app = express();

// ==== CONFIG ====
const FRONT_ORIGIN = "https://alex-mentor.netlify.app";
const N8N_BASE = "https://n8n.icc-e.org";
const PORT = 8787;
// AUMENTADO A 10 MINUTOS (600,000 ms) para evitar cortes
const UPSTREAM_TIMEOUT_MS = 600_000;

const ROUTE_MAP = {
	chat: "/webhook/mentor-chat-mode",
	// CORRECCIÓN: Apuntamos a la ruta real que creaste en n8n
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

// === NUEVO: CONFIGURACIÓN DE TIMEOUT DEL SOCKET ===
// Esto evita que Express corte la conexión a los 2 minutos por defecto
app.use((req, res, next) => {
	req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000); // 10 min + 5 seg de gracia
	res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	next();
});
// =================================================

async function forward({ path, method, headers, body }) {
	const controller = new AbortController();
	// Timeout del fetch interno
	const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	const {
		host,
		origin,
		"content-length": cl,
		"content-type": ct,
		...safeHeaders
	} = headers || {};
	const url = `${N8N_BASE}${path}`;

	console.log(`[PROXY] ⏳ Esperando respuesta de n8n (max 10 min)...`);

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
		// Si es error de tiempo, lo avisamos claro
		if (error.name === "AbortError") {
			console.error("[PROXY] ❌ Timeout: n8n tardó más de 10 minutos.");
			return {
				status: 504,
				body: JSON.stringify({ error: "Tiempo de espera agotado (10 min)" }),
			};
		}
		throw error;
	}
}

app.all(/^\/webhook\/(.*)/, async (req, res) => {
	try {
		let targetPath = req.originalUrl;
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

app.options(/^\/webhook\/(.*)/, (req, res) => res.status(204).end());

http.createServer(app).listen(PORT, () => {
	console.log(`🚀 Proxy corriendo en http://localhost:${PORT}`);
	console.log(
		`⏱️  Timeout configurado a: ${UPSTREAM_TIMEOUT_MS / 60000} minutos`
	);
});
