import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// --- CONFIGURACIÓN DE RATE LIMITING ---
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const MAX_REQUESTS_PER_WINDOW = 50;

// Orígenes permitidos para CORS. Agrega tu dominio de Netlify aquí.
const ALLOWED_ORIGINS = [
  "https://alex-mentor.netlify.app", // Dominio de producción
  "http://localhost:8080", // Desarrollo local si usas un servidor simple
  "http://127.0.0.1:5500" // Desarrollo local con Live Server
];

// Mapa de acciones a los webhooks de n8n (leídos desde variables de entorno de Netlify)
const N8N_WEBHOOKS = {
  chat: process.env.N8N_CHAT_WEBHOOK,
  pdf_status: process.env.N8N_PDF_WEBHOOK,
};

// Inicializar Supabase (usando variables de entorno del servidor de Netlify)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Timeout para la petición a n8n (en milisegundos)
const UPSTREAM_TIMEOUT_MS = 300000; // 5 minutos

export const handler = async (event, context) => {
  const origin = event.headers.origin;
  const corsHeaders = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  };

  // Responder a peticiones pre-flight de CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  // Validar que la petición sea POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed", headers: corsHeaders };
  }

  // Validar que el cuerpo de la petición exista
  if (!event.body) {
    return { statusCode: 400, body: "Bad Request: Missing body", headers: corsHeaders };
  }

  try {
    // --- INICIO: LÓGICA DE RATE LIMITING POR IP ---
    const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';
    
    try {
      const timeWindowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

      // Contar peticiones recientes de esta IP
      const { count, error: countError } = await supabase
        .from('request_logs')
        .select('*', { count: 'exact', head: true })
        .eq('ip_address', clientIp)
        .gte('created_at', timeWindowStart);

      if (countError) throw countError;

      if (count >= MAX_REQUESTS_PER_WINDOW) {
        return {
          statusCode: 429, // Too Many Requests
          body: JSON.stringify({ error: 'Demasiadas solicitudes. Por favor espera unos minutos.' }),
          headers: corsHeaders
        };
      }

      // Registrar la petición actual
      const { error: insertError } = await supabase.from('request_logs').insert({
        ip_address: clientIp,
        endpoint: JSON.parse(event.body)?.action || 'unknown'
      });

      if (insertError) throw insertError;

    } catch (err) {
      console.error('Error en el proceso de Rate Limiting con Supabase:', err.message);
      // Decidimos no bloquear la petición si falla la base de datos, pero sí registrar el error.
    }
    // --- FIN: LÓGICA DE RATE LIMITING ---

    const { action, payload } = JSON.parse(event.body);

    // Validar que la acción y el webhook correspondiente existan
    if (!action || !N8N_WEBHOOKS[action]) {
      return { statusCode: 400, body: `Bad Request: Invalid action '${action}'`, headers: corsHeaders };
    }

    const targetUrl = N8N_WEBHOOKS[action];

    // Reenviar la petición a n8n
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text();

    return {
      statusCode: response.status,
      headers: { ...corsHeaders, "Content-Type": response.headers.get("content-type") || "application/json" },
      body: responseBody,
    };
  } catch (error) {
    const errorMessage = error.name === 'AbortError' ? 'Function timeout waiting for n8n' : `Internal Server Error: ${error.message}`;
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }), headers: corsHeaders };
  }
};