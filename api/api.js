import { CONFIG } from '../js/config.js';
import { state } from '../js/state.js';

// Función auxiliar para hablar con la función de Netlify
async function callProxy(action, payload) {
	const response = await fetch(CONFIG.apiUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action: action, // 'chat' o 'pdf_status'
			payload: payload, // Los datos para n8n
		}),
	});

	if (response.status === 429) {
		throw new Error("Has excedido el límite de mensajes. Espera un momento.");
	}

	if (!response.ok) throw new Error(`Error en la petición: ${response.status}`);

	const contentType = response.headers.get("content-type");
	if (contentType && contentType.includes("application/json")) {
		return response.json();
	} else {
		const text = await response.text();
		console.log("Respuesta de n8n (Texto):", text);

		try {
			return JSON.parse(text);
		} catch (e) {
			return { response: text, reply: text };
		}
	}
}

export async function checkConnection() {
	try {
		await callProxy("chat", {
			message: "_connection_test",
			userId: state.userId,
			sessionId: state.sessionId,
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
	// La acción 'pdf_status' le dice a la función de Netlify que use el webhook de estado del PDF
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
