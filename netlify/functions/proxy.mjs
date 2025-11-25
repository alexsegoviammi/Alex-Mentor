import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import axios from "axios"; // <--- NUEVO IMPORT

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

// --- MIDDLEWARE DE TIMEOUT ---
app.use((req, res, next) => {
	if (!IS_NETLIFY) {
		if (req.setTimeout) req.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
		if (res.setTimeout) res.setTimeout(UPSTREAM_TIMEOUT_MS + 5000);
	}
	next();
});

// --- FUNCIÓN FORWARD MODIFICADA CON AXIOS ---
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

	const url = `${N8N_BASE}${path}`;
	console.log(`[PROXY] ⏳ A n8n: ${url} (Timeout: ${UPSTREAM_TIMEOUT_MS}ms)`);

	try {
		// Usamos AXIOS en lugar de fetch
		const response = await axios({
			method: method,
			url: url,
			headers: { ...safeHeaders, "Content-Type": "application/json" },
			data: ["GET", "HEAD"].includes(method) ? undefined : body,
			signal: controller.signal,
			// Importante: Evita que axios lance error en 404/500 (queremos pasar la respuesta tal cual)
			validateStatus: () => true,
			// Importante: Queremos el texto crudo para procesarlo igual que antes
			responseType: "text",
			transformResponse: [(data) => data],
		});

		clearTimeout(t);

		return { status: response.status, body: response.data };
	} catch (error) {
		clearTimeout(t);

		// Manejo de errores específico de Axios
		if (
			axios.isCancel(error) ||
			error.code === "ECONNABORTED" ||
			error.name === "CanceledError"
		) {
			const msg = IS_NETLIFY
				? "Timeout: Netlify cortó (límite alcanzado). Iniciando polling..."
				: "Timeout: n8n tardó más de 10 minutos.";

			return {
				status: 504,
				body: JSON.stringify({ error: msg }),
			};
		}

		// Otros errores de conexión
		console.error("[PROXY AXIOS ERROR]", error.message);
		throw error;
	}
}

// Ruta Universal
app.all(/.*/, async (req, res) => {
	try {
		let cleanUrl = req.originalUrl.replace("/.netlify/functions/proxy", "");
		if (!cleanUrl || cleanUrl.startsWith("?")) {
			cleanUrl = "/" + cleanUrl;
		}

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

if (!IS_NETLIFY) {
	const PORT = 8787;
	app.listen(PORT, () => {
		console.log(`🚀 Proxy Local corriendo en http://localhost:${PORT}`);
		console.log(`⏱️  Modo Local: Timeout extendido a 10 minutos.`);
	});
}

export const handler = serverless(app);
