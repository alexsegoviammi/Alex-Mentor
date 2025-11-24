// import { CONFIG } from './config.js';
// import { state } from './state.js';

// async function fetchWithTimeout(url, options, timeout) {
//     return fetch(url, {
//         ...options,
//         signal: AbortSignal.timeout(timeout)
//     });
// }

// export async function checkConnection() {
//     try {
//         const response = await fetchWithTimeout(CONFIG.webhookUrl, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ message: '_connection_test', userId: state.userId, sessionId: state.sessionId }),
//         }, 10000);

//         return response.ok;
//     } catch (error) {
//         console.error('Error de conexión:', error);
//         return false;
//     }
// }

// export async function postMessage(message) {
//     const payload = {
//         message,
//         userId: state.userId,
//         sessionId: state.sessionId,
//         currentStep: state.currentStep,
//         state: state.conversationData
//     };

//     const response = await fetchWithTimeout(CONFIG.webhookUrl, {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify(payload),
//     }, CONFIG.requestTimeout);

//     if (!response.ok) throw new Error(`HTTP ${response.status}`);
//     return response.json();
// }

// export async function checkPDFStatus() {
//     const response = await fetchWithTimeout(CONFIG.statusUrl, {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ sessionId: state.sessionId }),
//     }, 10000);

//     if (!response.ok) throw new Error(`HTTP ${response.status}`);
//     return response.json();
// }

// export async function sendEmail(email, pdfUrl) {
//     const payload = {
//         message: '_send_email', to: email, pdfUrl,
//         userId: state.userId, sessionId: state.sessionId, state: state.conversationData
//     };
//     const response = await fetchWithTimeout(CONFIG.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 30000);
//     if (!response.ok) throw new Error('Error del servidor al enviar email');
// }

// En api.js (ahora funcionará bien)
import { CONFIG } from "../js/config.js";
import { state } from "../js/state.js";

// Función auxiliar genérica para hablar con el Proxy
async function callProxy(action, payload) {
	const response = await fetch(CONFIG.apiUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action: action,
			payload: payload,
		}),
	});

	if (response.status === 429) {
		throw new Error("Has excedido el límite de mensajes. Espera un momento.");
	}

	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	// === INICIO DE LA CORRECCIÓN ===
	// Verificamos si la respuesta es JSON o Texto para que no falle
	const contentType = response.headers.get("content-type");
	if (contentType && contentType.includes("application/json")) {
		return response.json();
	} else {
		const text = await response.text();
		console.log("Respuesta de n8n (Texto):", text);

		// --- AGREGA ESTO PARA QUE INTENTE LEER EL JSON ---
		try {
			return JSON.parse(text); // Si es JSON válido, úsalo como objeto
		} catch (e) {
			// Si falla, entonces sí devuélvelo como texto simple
			return { response: text, reply: text };
		}
		// -------------------------------------------------
	}
	// === FIN DE LA CORRECCIÓN ===
}

export async function checkConnection() {
	try {
		// CORRECCIÓN: Agregamos sessionId: state.sessionId
		await callProxy("chat", {
			message: "_connection_test",
			userId: state.userId,
			sessionId: state.sessionId, // <--- ESTO ES LA CLAVE
		});
		return true;
	} catch (e) {
		return false;
	}
}

export async function postMessage(message) {
	const payload = {
		message,
		userId: state.userId,
		sessionId: state.sessionId,
		currentStep: state.currentStep,
		state: state.conversationData,
	};
	// Acción: 'chat'
	return callProxy("chat", payload);
}

export async function checkPDFStatus() {
	// Acción: 'pdf_status'
	return callProxy("pdf_status", { sessionId: state.sessionId });
}

export async function sendEmail(email, pdfUrl) {
	const payload = {
		message: "_send_email",
		to: email,
		pdfUrl,
		userId: state.userId,
		// ... resto de datos
	};
	// Reutilizamos el endpoint de chat que maneja el comando _send_email
	return callProxy("chat", payload);
}
