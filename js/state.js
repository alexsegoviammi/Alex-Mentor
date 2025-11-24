export const state = {
  pdfReady: false,
  userId: `user_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
  sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
  currentStep: 0,
  isConnected: false,
  isTyping: false,
  conversationData: {},
  isPolling: false
};