// public/app.js — interface du chat (aucune dépendance)
const chat = document.getElementById("chat");
const inputForm = document.getElementById("inputForm");
const msgInput = document.getElementById("msgInput");
const quickRow = document.getElementById("quick");
const leadWrap = document.getElementById("leadWrap");
const leadForm = document.getElementById("leadForm");
const stateBadge = document.getElementById("stateBadge");
const resetBtn = document.getElementById("resetBtn");

function makeId() {
  return window.crypto?.randomUUID
    ? crypto.randomUUID()
    : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

let convId = localStorage.getItem("aria_conv") || makeId();
localStorage.setItem("aria_conv", convId);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nl = (s) => esc(s).replace(/\n/g, "<br>");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const avatar = role === "agent" ? '<span class="avatar">✦</span>' : "";
  div.innerHTML = `${avatar}<div class="bubble">${nl(text)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addTyping() {
  const d = document.createElement("div");
  d.className = "msg agent typing";
  d.id = "typing";
  d.innerHTML =
    '<span class="avatar">✦</span><div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

function removeTyping() {
  document.getElementById("typing")?.remove();
}

function showQuick(list) {
  quickRow.innerHTML = "";
  if (!Array.isArray(list)) return;
  for (const q of list.slice(0, 4)) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => send(q));
    quickRow.appendChild(b);
  }
}

function hideQuick() {
  quickRow.innerHTML = "";
}

function showLead() {
  leadWrap.classList.remove("hidden");
  leadWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideLead() {
  leadWrap.classList.add("hidden");
}

function setState(label) {
  if (label) stateBadge.textContent = label;
}

async function api(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

let busy = false;

async function send(text) {
  if (busy) return;
  const msg = String(text || "").trim();
  if (!msg) return;
  busy = true;
  hideQuick();
  msgInput.value = "";
  addMsg("user", msg);
  addTyping();
  try {
    const data = await api("/demo/api/chat", { conversationId: convId, message: msg });
    removeTyping();
    setState(data.stateLabel);
    if (data.showLeadForm) showLead();
    else hideLead();
    addMsg("agent", data.reply);
    showQuick(data.quickReplies);
  } catch {
    removeTyping();
    addMsg("agent", "Désolé, je n'ai pas réussi à me connecter au serveur. Réessayez dans un instant.");
  }
  busy = false;
  msgInput.focus();
}

inputForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send(msgInput.value);
});

leadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const name = document.getElementById("leadName").value.trim();
  const email = document.getElementById("leadEmail").value.trim();
  const phone = document.getElementById("leadPhone").value.trim();
  try {
    const data = await api("/demo/api/leads", { conversationId: convId, name, email, phone });
    hideLead();
    leadForm.reset();
    setState(data.stateLabel);
    addMsg("agent", data.reply);
    showQuick(data.quickReplies);
  } catch {
    addMsg("agent", "Impossible d'enregistrer vos coordonnées pour le moment. Réessayez, ou écrivez-les simplement dans le chat.");
  }
  busy = false;
});

resetBtn.addEventListener("click", async () => {
  if (busy) return;
  try {
    const data = await api("/demo/api/reset", { conversationId: convId });
    chat.innerHTML = "";
    hideLead();
    setState(data.stateLabel);
    addMsg("agent", data.reply);
    showQuick(data.quickReplies);
  } catch {
    // garde la session en cas d'erreur
  }
});

// Message de bienvenue initial
addMsg(
  "agent",
  "Bonjour ! 👋 Je suis Aria, l'agent de vente IA de NovaTech. Posez-moi vos questions sur FlowCRM — tarifs, fonctionnalités, objections… — ou je vous organise une démo de 15 minutes. Par quoi commençons-nous ?"
);
showQuick(["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"]);
msgInput.focus();
