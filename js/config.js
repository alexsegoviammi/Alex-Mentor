export const CONFIG = {
	// IMPORTANTE: Apunta al puerto 8787.
	// El proxy recibirá "chat", verá el mapa y lo mandará a "mentor-chat-mode"
	apiUrl: "http://localhost:8787/webhook/chat",

	// Resto de la config...
	pollingInterval: 15000,
	maxPollingAttempts: 40,
	requestTimeout: 180000,
	statusUrl: "http://localhost:8787/webhook/status", // (Opcional, si usas checkPDFStatus)
};
