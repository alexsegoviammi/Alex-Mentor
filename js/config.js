export const CONFIG = {
	// Apunta a la función serverless de Netlify que actúa como proxy.
	// Esta única URL gestionará todas las acciones (chat, status, etc.).
	apiUrl: "/.netlify/functions/proxy",

	// Tiempos y reintentos
	pollingInterval: 15000,
	maxPollingAttempts: 40,
	requestTimeout: 180000,
};
