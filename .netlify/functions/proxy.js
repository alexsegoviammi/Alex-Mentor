const { createClient } = require("@supabase/supabase-js");

// ==== CONFIGURACIÓN BÁSICA ====
const N8N_BASE = "https://n8n.icc-e.org";
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const MAX_REQUESTS_PER_WINDOW = 50;
const UPSTREAM_TIMEOUT_MS = 25000; // Netlify corta a los 10s (free) o 26s (pro).

// Inicializar Supabase
const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==== MAPA DE RUTAS (Lo que arreglamos hoy) ====
const ROUTE_MAP = {
	chat: "/webhook/mentor-chat-mode", // Chat principal
	pdf_status: "/webhook/mentor-chat-mode-pdf", // Tu nueva ruta de polling
	task: "/webhook/mentor-task", // (Opcional) Tareas
};

// Headers CORS para permitir que tu frontend hable con esto
const corsHeaders = {
	"Access-Control-Allow-Origin": "*", // O pon tu dominio: 'https://alex-mentor.netlify.app'
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event, context) => {
	// 0. Responder a OPTIONS (Pre-flight de CORS)
	if (event.httpMethod === "OPTIONS") {
		return { statusCode: 200, headers: corsHeaders, body: "" };
	}

	// 1. Solo permitir POST
	if (event.httpMethod !== "POST") {
		return {
			statusCode: 405,
			headers: corsHeaders,
			body: "Method Not Allowed",
		};
	}

	// 2. Obtener IP y Parsear Body
	const clientIp =
		event.headers["x-nf-client-connection-ip"] ||
		event.headers["client-ip"] ||
		"unknown";
	let body;
	try {
		body = JSON.parse(event.body);
	} catch (e) {
		return { statusCode: 400, headers: corsHeaders, body: "Invalid JSON" };
	}

	// 3. RATE LIMITING (Tu lógica de Supabase intacta)
	try {
		const timeWindow = new Date(
			Date.now() - RATE_LIMIT_WINDOW_MS
		).toISOString();
		const { count, error } = await supabase
			.from("request_logs")
			.select("*", { count: "exact", head: true })
			.eq("ip_address", clientIp)
			.gte("created_at", timeWindow);

		if (error) throw error;

		if (count >= MAX_REQUESTS_PER_WINDOW) {
			return {
				statusCode: 429,
				headers: corsHeaders,
				body: JSON.stringify({
					error: "Límite de velocidad excedido. Espera unos minutos.",
				}),
			};
		}

		// Registrar petición (sin bloquear el hilo principal usamos await rápido)
		await supabase.from("request_logs").insert({
			ip_address: clientIp,
			endpoint: body.action || "unknown",
		});
	} catch (err) {
		console.error("Error Supabase:", err);
		// Dejamos pasar si falla la DB para no tirar el servicio
	}

	// 4. ENRUTAMIENTO (La parte nueva)
	let targetPath = "";

	if (body.action && ROUTE_MAP[body.action]) {
		targetPath = ROUTE_MAP[body.action];
	} else {
		// Fallback o error si la acción no existe
		return {
			statusCode: 400,
			headers: corsHeaders,
			body: JSON.stringify({ error: "Acción no válida" }),
		};
	}

	const targetUrl = `${N8N_BASE}${targetPath}`;
	console.log(`[PROXY] Redirigiendo ${body.action} -> ${targetUrl}`);

	// 5. REENVIAR A N8N (Con timeout y limpieza de headers)
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	try {
		const response = await fetch(targetUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" }, // Header limpio forzado
			body: JSON.stringify(body.payload || {}), // Solo enviamos el payload útil
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Intentamos leer JSON, si no, Texto (para evitar errores de conexión falsos)
		const text = await response.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			data = { response: text, reply: text }; // Fallback si n8n manda texto plano
		}

		if (!response.ok) {
			throw new Error(`n8n respondió con ${response.status}: ${text}`);
		}

		return {
			statusCode: 200,
			headers: corsHeaders,
			body: JSON.stringify(data),
		};
	} catch (error) {
		clearTimeout(timeoutId);
		console.error("Error Proxy:", error);

		// Manejo específico de Timeout
		if (error.name === "AbortError") {
			return {
				statusCode: 504,
				headers: corsHeaders,
				body: JSON.stringify({
					error: "Timeout: n8n tardó demasiado en responder.",
				}),
			};
		}

		return {
			statusCode: 500,
			headers: corsHeaders,
			body: JSON.stringify({
				error: error.message || "Error interno del servidor",
			}),
		};
	}
};
