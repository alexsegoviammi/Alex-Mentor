import { CONFIG } from '../js/config.js';
import { state } from '../js/state.js';

// Función auxiliar genérica para hablar con el Proxy
async function callProxy(action, payload) {
    const response = await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: action, // Le dice al proxy a dónde ir (chat o pdf)
            payload: payload // Los datos reales para n8n
        })
    });

    if (response.status === 429) {
        throw new Error('Has excedido el límite de mensajes. Espera un momento.');
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

export async function checkConnection() {
    // Usamos 'chat' para el test de conexión también
    try {
        await callProxy('chat', { message: '_connection_test', userId: state.userId });
        return true;
    } catch (e) { return false; }
}

export async function postMessage(message) {
    const payload = {
        message,
        userId: state.userId,
        sessionId: state.sessionId,
        currentStep: state.currentStep,
        state: state.conversationData
    };
    // Acción: 'chat'
    return callProxy('chat', payload);
}

export async function checkPDFStatus() {
    // Acción: 'pdf_status'
    return callProxy('pdf_status', { sessionId: state.sessionId });
}

export async function sendEmail(email, pdfUrl) {
    const payload = {
        message: '_send_email', 
        to: email, 
        pdfUrl,
        userId: state.userId, 
        // ... resto de datos
    };
    // Reutilizamos el endpoint de chat que maneja el comando _send_email
    return callProxy('chat', payload); 
}