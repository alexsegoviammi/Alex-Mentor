// export const CONFIG = {
//   webhookUrl: 'https://n8n.icc-e.org/webhook/mentor-chat',
//   statusUrl: 'https://n8n.icc-e.org/webhook/mentor-chat-pdf',
//   requestTimeout: 50000, // 50 segundos para evitar timeout de webhook
//   pollingInterval: 15000, // Verificar PDF cada 15 segundos
//   maxPollingAttempts: 24 // 6 minutos máximo (24 * 15s)
// };

export const CONFIG = {
  // Ahora apuntamos a TU mismo dominio, a la función serverless
  apiUrl: '/.netlify/functions/proxy', 
  requestTimeout: 50000,
  pollingInterval: 15000,
  maxPollingAttempts: 24
};