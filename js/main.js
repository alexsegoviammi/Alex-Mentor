import { CONFIG } from './config.js';
import { state } from './state.js';
import { elements } from './dom.js';
import * as ui from './ui.js';
import * as api from '../api.js';

async function initializeApp() {
  console.log('Alex MVP inicializado', { userId: state.userId, sessionId: state.sessionId });
  const connected = await api.checkConnection();
  ui.setConnectionStatus(connected, connected ? 'Conectado' : 'Error de conexión');
}

function startConversation() {
  if (!state.isConnected) {
    ui.showError('No hay conexión con el servidor. Reintentando...');
    initializeApp();
    return;
  }

  elements.welcomeScreen.style.display = 'none';
  elements.messageInput.disabled = false;
  elements.sendBtn.disabled = false;
  elements.messageInput.focus();

  setTimeout(() => handleMessageProcessing('_iniciar_conversacion'), 500);
}

function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || state.isTyping) return;

  ui.showUserMessage(message);
  elements.messageInput.value = '';
  ui.removeQuickReplies();
  handleMessageProcessing(message);
}

async function handleMessageProcessing(message) {
  ui.showTyping();
  const isGeneratingPlan = message.toLowerCase().includes('generar plan completo');

  try {
    const data = await api.postMessage(message);
    ui.hideTyping();
    handleResponse(data);

    if (isGeneratingPlan && !state.isPolling) {
      startPDFPolling();
    }
  } catch (error) {
    ui.hideTyping();
    console.error('Error:', error);

    if (isGeneratingPlan) {
      ui.showAIMessage("El proceso se está ejecutando. Verificando estado...");
      startPDFPolling();
    } else {
      ui.showError('Error conectando con Alex. Intenta de nuevo.');
    }
  }
}

function handleResponse(data) {
  if (!data) return;

  if (data.pdfGenerated && data.pdfUrl && !state.isPolling) {
    state.isPolling = false;
    localStorage.setItem('alex_last_pdf_url', data.pdfUrl);
    for (let i = 1; i <= 7; i++) ui.markSectionCompleted(i);
    ui.showPDFReadyMessage();
    return;
  }

  const aiText = data.response || data.reply;
  if (aiText) ui.showAIMessage(aiText);

  const previousStep = state.currentStep;
  if (data.currentStep !== undefined) {
    state.currentStep = parseInt(data.currentStep);
    if (state.currentStep > previousStep) {
      ui.updatePlanSection(state.currentStep);
    }
  }

  if (data.state) state.conversationData = data.state;
  if (data.quickReplies?.length > 0) ui.addQuickReplies(data.quickReplies);
}

async function startPDFPolling() {
  if (state.isPolling) return;
  state.isPolling = true;
  let attempts = 0;

  const poll = async () => {
    if (attempts >= CONFIG.maxPollingAttempts) {
      state.isPolling = false;
      ui.showError('El PDF está tardando más de lo esperado.');
      return;
    }

    try {
      const data = await api.checkPDFStatus();
      if (data.pdfGenerated && data.pdfUrl) {
        state.isPolling = false;
        localStorage.setItem('alex_last_pdf_url', data.pdfUrl);
        ui.markSectionCompleted(7);
        ui.showPDFReadyMessage();
        return;
      }
    } catch (error) {
      // Continue polling on error
    }

    attempts++;
    if (attempts % 4 === 0) { // Cada minuto
      ui.showAIMessage(`Generando tu plan... ${Math.min(80 + attempts * 2, 95)}% completado.`);
    }
    setTimeout(poll, CONFIG.pollingInterval);
  };

  poll();
}

function selectQuickReply(reply) {
  if (reply === "Generar plan completo") {
    ui.showUserMessage("Generar plan completo");
    ui.removeQuickReplies();
    ui.showAIMessage("¡Perfecto! Estoy generando tu plan de negocio completo. Esto tomará unos momentos...");
    ui.markSectionCompleted(6);
    ui.activateSection('section-final');
    handleMessageProcessing("Generar plan completo");
  } else {
    elements.messageInput.value = reply;
    sendMessage();
  }
}

function downloadPlan() {
  const pdfUrl = localStorage.getItem('alex_last_pdf_url');
  if (pdfUrl) {
    window.open(pdfUrl, '_blank');
    ui.showAIMessage('✅ Abriendo tu PDF en una nueva pestaña.');
  } else {
    ui.showError('No se encontró un PDF generado.');
  }
}

async function promptEmailAndSend() {
  const email = prompt('¿A qué dirección de email quieres enviar tu plan?\n\nEjemplo: nombre@gmail.com');
  if (!email) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    ui.showError('Por favor introduce un email válido');
    return;
  }

  const pdfUrl = localStorage.getItem('alex_last_pdf_url');
  if (!pdfUrl) {
    ui.showError('No se encontró un PDF generado.');
    return;
  }

  ui.showAIMessage(`📧 Enviando tu plan a ${email}...`);
  try {
    await api.sendEmail(email, pdfUrl);
    ui.showAIMessage(`✅ ¡Plan enviado exitosamente a ${email}!`);
  } catch (error) {
    ui.showError('No se pudo enviar el email. Puedes descargar el PDF directamente.');
  }
}

function askQuestions() {
  ui.showAIMessage(`¡Perfecto! Ahora puedo responder preguntas específicas sobre tu plan de negocio.
  \n\nPuedes preguntarme sobre:\n• Detalles de financiación disponible\n• Estrategias de marketing para tu cliente objetivo\n• Análisis de competencia en tu sector\n• Proyecciones financieras más detalladas\n• Pasos legales para constituir tu empresa\n• Contactos y recursos en Gran Canaria\n\n¿Qué te gustaría saber?`);
  elements.messageInput.placeholder = 'Haz tu pregunta sobre el plan de negocio...';
  elements.messageInput.focus();
}

const actionHandlers = {
  downloadPlan,
  promptEmailAndSend,
  askQuestions,
};

document.addEventListener('DOMContentLoaded', () => {
  elements.startBtn.addEventListener('click', startConversation);
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  elements.chatMessages.addEventListener('click', (e) => {
    const quickReply = e.target.closest('.quick-response');
    if (quickReply) selectQuickReply(quickReply.dataset.reply);

    const actionBtn = e.target.closest('.action-btn');
    if (actionBtn && actionHandlers[actionBtn.dataset.action]) {
      actionHandlersactionBtn.dataset.action;
    }
  });

  initializeApp();
});