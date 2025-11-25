// Función auxiliar para persistencia (Fingerprinting)
function getPersistentId(key, prefix) {
  // 1. Intentamos leer del almacenamiento local
  let id = localStorage.getItem(key);
  
  // 2. Si NO existe (usuario nuevo o borró caché), creamos uno y lo guardamos
  if (!id) {
    id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem(key, id);
  }
  
  // 3. Devolvemos el ID (ya sea el viejo recuperado o el nuevo)
  return id;
}

export const state = {
  pdfReady: false,
  // Aquí está la magia: Usamos la función que lee del disco
  userId: getPersistentId('alex_user_id', 'user'),
  sessionId: getPersistentId('alex_session_id', 'session'), 
  
  currentStep: 0,
  isConnected: false,
  isTyping: false,
  conversationData: {},
  isPolling: false
};