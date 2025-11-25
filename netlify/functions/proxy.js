import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// --- CONFIGURACIÓN DE SEGURIDAD ---
// 60 peticiones cada 24 horas por IP (suficiente para 1 plan completo)
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

// Inicializar Supabase con variables de entorno de Netlify
const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mapa de Webhooks
const N8N_WEBHOOKS = {
	chat: process.env.N8N_CHAT_WEBHOOK,
	pdf_status: process.env.N8N_PDF_WEBHOOK,
};

export const handler = async (event, context) => {
	// 1. Manejo de CORS (Preflight OPTIONS)
	const headers = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
	};

	if (event.httpMethod === "OPTIONS") {
		return { statusCode: 200, headers, body: "" };
	}

	if (event.httpMethod !== "POST") {
		return { statusCode: 405, headers, body: "Method Not Allowed" };
	}

	// 2. Obtener IP del cliente (Header específico de Netlify)
	const clientIp =
		event.headers["x-nf-client-connection-ip"] ||
		event.headers["client-ip"] ||
		"unknown";

	// 3. Parsear cuerpo de la petición
	let body;
	try {
		body = JSON.parse(event.body);
	} catch (e) {
		return { statusCode: 400, headers, body: "Invalid JSON" };
	}

	// 4. RATE LIMITING (Lógica de Supabase restaurada)
	try {
		const timeWindow = new Date(
			Date.now() - RATE_LIMIT_WINDOW_MS
		).toISOString();

		// Consultar logs recientes
		const { count, error } = await supabase
			.from("request_logs")
			.select("*", { count: "exact", head: true })
			.eq("ip_address", clientIp)
			.gte("created_at", timeWindow);

		if (error) throw error;

		// Bloquear si excede el límite
		if (count >= MAX_REQUESTS_PER_WINDOW) {
			console.warn(`Bloqueo Rate Limit: IP ${clientIp}`);
			return {
				statusCode: 429,
				headers,
				body: JSON.stringify({
					error:
						"Has alcanzado el límite diario de uso (1 Plan/día). Por favor intenta mañana.",
				}),
			};
		}

		// Registrar nueva petición
		await supabase.from("request_logs").insert({
			ip_address: clientIp,
			endpoint: body.action || "unknown",
		});
	} catch (err) {
		console.error("Error en Rate Limiting (Supabase):", err);
		// Fail-open: Si falla la BD, dejamos pasar la petición para no interrumpir el servicio
	}

	// 5. VALIDAR Y ENRUTAR A N8N
	const action = body.action;
	const targetUrl = N8N_WEBHOOKS[action];

	if (!targetUrl) {
		return { statusCode: 400, headers, body: `Acción no válida: ${action}` };
	}

	// 6. LLAMADA A N8N
	try {
		// Usamos AbortController para el timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 26000); // 26s es el límite hard de Netlify Functions

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

		clearTimeout(timeoutId);

		const responseText = await response.text();

		return {
			statusCode: response.status,
			headers: { ...headers, "Content-Type": "application/json" },
			body: responseText,
		};
	} catch (error) {
		console.error("Error upstream n8n:", error);
		const msg =
			error.name === "AbortError"
				? "Timeout: La IA está tardando, intenta verificar estado en unos segundos."
				: "Error de comunicación con el Mentor IA";
		return {
			statusCode: 504,
			headers,
			body: JSON.stringify({ error: msg }),
		};
	}
};
