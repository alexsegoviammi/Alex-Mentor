const { createClient } = require('@supabase/supabase-js');

// Configuración de límites (Ej: 50 mensajes cada 10 minutos)
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const MAX_REQUESTS_PER_WINDOW = 50;

// Inicializar Supabase (usando variables de entorno del servidor)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ¡OJO! Usamos la Service Role para escribir sin restricciones en el back
);

exports.handler = async (event, context) => {
  // 1. Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 2. Obtener la IP del cliente (Netlify nos la da)
  const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';
  
  // 3. Parsear el cuerpo para saber a qué webhook de n8n vamos
  // El frontend enviará un parámetro "action" para decidir a qué webhook ir
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // 4. RATE LIMITING CON SUPABASE
  try {
    const timeWindow = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    // Contamos peticiones de esta IP en la ventana de tiempo
    const { count, error } = await supabase
      .from('request_logs')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', clientIp)
      .gte('created_at', timeWindow);

    if (error) throw error;

    if (count >= MAX_REQUESTS_PER_WINDOW) {
      return {
        statusCode: 429,
        body: JSON.stringify({ 
          error: 'Demasiadas solicitudes. Por favor espera unos minutos.' 
        })
      };
    }

    // Si pasa el filtro, registramos esta nueva petición
    await supabase.from('request_logs').insert({
      ip_address: clientIp,
      endpoint: body.action || 'unknown'
    });

  } catch (err) {
    console.error('Error en rate limiting:', err);
    // En caso de error de DB, decidimos si bloquear o dejar pasar (aquí dejamos pasar por seguridad del servicio)
  }

  // 5. ENRUTAMIENTO OCULTO
  // Aquí definimos las URLs reales. El navegador NUNCA las verá.
  let targetUrl = '';
  
  if (body.action === 'chat') {
    targetUrl = process.env.N8N_CHAT_WEBHOOK; // Variable de entorno
  } else if (body.action === 'pdf_status') {
    targetUrl = process.env.N8N_PDF_WEBHOOK;  // Variable de entorno
  } else {
    return { statusCode: 400, body: 'Acción no válida' };
  }

  // 6. REENVIAR A N8N (El Proxy real)
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body.payload) // Enviamos solo los datos limpios a n8n
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error comunicando con el mentor IA' })
    };
  }
};