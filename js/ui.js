import { elements, stepSectionMap } from './dom.js';
import { state } from './state.js';
import { escapeHTML, formatMessage } from './utils.js';

export function scrollToBottom() {
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

export function showUserMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user';
  messageDiv.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-content"><div class="message-text">${escapeHTML(message)}</div></div>`;
  elements.chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

export function showAIMessage(message, actions = []) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ai';
  let actionsHTML = '';
  if (actions.length > 0) {
    actionsHTML = '<div class="message-actions">' +
      actions.map(a => `<button class="action-btn" data-action="${a.handler}">${a.text}</button>`).join('') +
      '</div>';
  }
  messageDiv.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-content">
      <div class="message-text">${formatMessage(message)}</div>
      ${actionsHTML}
    </div>`;
  elements.chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

export function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.innerHTML = `<span>⚠️</span><span>${escapeHTML(message)}</span>`;
  elements.chatMessages.appendChild(errorDiv);
  scrollToBottom();
}

export function showTyping() {
  if (document.getElementById('typing')) return;
  const typingDiv = document.createElement('div');
  typingDiv.className = 'typing-indicator';
  typingDiv.id = 'typing';
  typingDiv.innerHTML = `
    <div class="typing-dots">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
    <span>Alex está escribiendo...</span>`;
  elements.chatMessages.appendChild(typingDiv);
  state.isTyping = true;
  scrollToBottom();
}

export function hideTyping() {
  const typing = document.getElementById('typing');
  if (typing) typing.remove();
  state.isTyping = false;
}

export function addQuickReplies(replies) {
  setTimeout(() => {
    const quickDiv = document.createElement('div');
    quickDiv.className = 'quick-responses';
    quickDiv.id = 'quickReplies';
    quickDiv.innerHTML = replies.map(r =>
      `<div class="quick-response" data-reply="${escapeHTML(r)}">${escapeHTML(r)}</div>`
    ).join('');
    elements.chatMessages.appendChild(quickDiv);
    scrollToBottom();
  }, 400);
}

export function removeQuickReplies() {
  const quick = document.getElementById('quickReplies');
  if (quick) quick.remove();
}

export function setConnectionStatus(connected, message) {
  state.isConnected = connected;
  elements.statusDot.classList.toggle('connected', connected);
  elements.statusText.textContent = message;
}

export function activateSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (section && !section.classList.contains('completed')) {
    section.classList.add('active');
    section.querySelector('.section-status').classList.add('active');
  }
}

export function markSectionCompleted(stepNumber, content = null) {
  const sectionId = stepSectionMap[stepNumber];
  const section = document.getElementById(sectionId);
  if (!section) return;

  const status = section.querySelector('.section-status');
  const contentElement = section.querySelector('.section-content');

  section.classList.remove('active');
  section.classList.add('completed');
  status.classList.add('completed');
  status.textContent = '✓';

  if (content) {
    const shortText = content.length > 50 ? content.substring(0, 50) + '...' : content;
    contentElement.textContent = shortText;
  }

  if (stepNumber === 6) {
    contentElement.innerHTML = '<strong>Análisis completado:</strong><br>• Mercado analizado<br>• Competidores identificados';
  } else if (stepNumber === 7) {
    contentElement.innerHTML = '<strong>Plan generado:</strong><br>• 25 páginas profesionales<br>• Análisis financiero';
  }
}

export function updatePlanSection(currentStep) {
  const completedStep = currentStep - 1;

  for (let i = 1; i <= completedStep; i++) {
    markSectionCompleted(i);
  }

  if (currentStep <= 7) {
    const nextSectionId = stepSectionMap[currentStep];
    if (nextSectionId) activateSection(nextSectionId);
  }
}

export function showPDFReadyMessage() {
  showAIMessage(
    '¡Tu Plan de Negocio está listo! He creado un documento profesional con análisis específico para Gran Canaria.',
    [
      { text: '📄 Descargar PDF', handler: 'downloadPlan' },
      { text: '📧 Enviar por email', handler: 'promptEmailAndSend' },
      { text: '💬 Hacer consultas', handler: 'askQuestions' }
    ]
  );
}
// En ui.js

export function updateStartButtonState(status) {
  // Asegúrate de importar 'elements' al principio de ui.js si no lo has hecho
  
  if (status === 'loading') {
    elements.startBtn.disabled = true;
    elements.startBtn.textContent = 'Conectando... ⏳';
    elements.startBtn.style.opacity = '0.7';
    elements.startBtn.style.cursor = 'wait';
  } else if (status === 'ready') {
    elements.startBtn.disabled = false;
    elements.startBtn.textContent = 'Comenzar mi plan de negocio 🚀';
    elements.startBtn.style.opacity = '1';
    elements.startBtn.style.cursor = 'pointer';
  } else if (status === 'error') {
    elements.startBtn.disabled = false; // Permitimos click para reintentar
    elements.startBtn.textContent = 'Sin conexión (Click para reintentar) 🔄';
    elements.startBtn.style.backgroundColor = '#ff6b6b'; // Opcional: rojo para error
  }
}