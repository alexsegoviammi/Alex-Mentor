// export const CONFIG = {
//   webhookUrl: 'https://n8n.icc-e.org/webhook/mentor-chat',
//   statusUrl: 'https://n8n.icc-e.org/webhook/mentor-chat-pdf',
//   requestTimeout: 50000, // 50 segundos para evitar timeout de webhook
//   pollingInterval: 15000, // Verificar PDF cada 15 segundos
//   maxPollingAttempts: 24 // 6 minutos máximo (24 * 15s)
// };
const isLocal =
	window.location.hostname === "localhost" ||
	window.location.hostname === "127.0.0.1";
export const CONFIG = {
	// Ahora apuntamos a TU mismo dominio, a la función serverless
	apiUrl: isLocal ? "http://localhost:8787/webhook/chat" : "/webhook/chat",
	requestTimeout: 180000,
	pollingInterval: 15000,
	maxPollingAttempts: 40,
	statusUrl: "/webhook/status", // (Opcional, si usas checkPDFStatus)
};
