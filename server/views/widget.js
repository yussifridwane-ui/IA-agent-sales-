// server/views/widget.js — Phase 6 : page du widget webchat public
// Autonomie totale (aucun layout d'application, aucune session). Le JavaScript
// est embarqué : visitor_id (localStorage) + session_id (sessionStorage),
// envoi via /api/widget/send, polling léger pour les réponses approuvées.
// JAMAIS de secret backend dans le HTML (seule la clé publique du widget).

import { esc } from "../security.js";

export function widgetPage({ org, agent, key, validKey }) {
  const orgName = esc(org?.name || "AI Sales Agent");
  const agentName = esc(agent?.name || "Assistant");
  const welcome = esc(agent?.welcome_message || "Bonjour 👋, comment puis-je vous aider ?");
  const language = agent?.language === "en" ? "en" : "fr";
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>💬 ${orgName} — Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #eef1f6; display: flex; align-items: flex-end; justify-content: flex-end; }
  .widget { width: 380px; max-width: 96vw; height: 560px; max-height: 86vh; background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(15, 23, 42, .25); display: flex; flex-direction: column; overflow: hidden; }
  .head { background: #4f46e5; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
  .head .avatar { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.2); display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .head .name { font-weight: 600; font-size: 15px; }
  .head .sub { font-size: 12px; opacity: .85; }
  .handoff { background: #fef3c7; color: #92400e; font-size: 12.5px; padding: 8px 16px; border-bottom: 1px solid #fde68a; display: none; }
  .handoff.show { display: block; }
  .msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #f8fafc; }
  .msg { max-width: 82%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
  .msg .time { display: block; font-size: 10px; opacity: .6; margin-top: 5px; }
  .typing { align-self: flex-start; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 14px; display: none; color: #64748b; font-size: 13px; }
  .typing.show { display: flex; gap: 5px; }
  .typing span { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; }
  .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
  .foot { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2e8f0; background: #fff; }
  .foot input { flex: 1; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font-size: 14px; outline: none; }
  .foot input:focus { border-color: #4f46e5; }
  .foot button { background: #4f46e5; color: #fff; border: 0; border-radius: 10px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
  .foot button:disabled { opacity: .55; cursor: default; }
  .empty { text-align: center; color: #94a3b8; font-size: 13.5px; padding: 30px 20px; }
  .invalid { width: 96vw; max-width: 420px; margin: 60px auto; background: #fff; border-radius: 14px; padding: 30px; box-shadow: 0 8px 30px rgba(15,23,42,.15); text-align: center; }
  .invalid h1 { font-size: 18px; margin-bottom: 10px; }
  .invalid p { color: #475569; font-size: 14px; line-height: 1.5; }
  .invalid code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; font-size: 12.5px; }
</style>
</head>
<body>
${validKey ? `
<div class="widget" role="dialog" aria-label="Chat">
  <div class="head">
    <div class="avatar">🤖</div>
    <div>
      <div class="name">${agentName}</div>
      <div class="sub">${orgName}</div>
    </div>
  </div>
  <div class="handoff" id="handoff">👤 Votre demande a été transmise à un conseiller — vous serez rappelé ici.</div>
  <div class="msgs" id="msgs"></div>
  <div class="typing" id="typing"><span></span><span></span><span></span></div>
  <div class="foot">
    <input id="input" type="text" placeholder="Écrivez votre message…" autocomplete="off" maxlength="2000"/>
    <button id="send" aria-label="Envoyer">Envoyer</button>
  </div>
</div>
<script>
(function () {
  "use strict";
  var KEY = ${JSON.stringify(key)};
  var qs = "k=" + encodeURIComponent(KEY);
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  // Identité visiteur : visitor_id persistant (device), session_id par visite.
  var visitor = localStorage.getItem("wsa_visitor");
  if (!visitor || visitor.length < 8) { visitor = uuid(); try { localStorage.setItem("wsa_visitor", visitor); } catch (e) {} }
  var session = sessionStorage.getItem("wsa_session");
  if (!session || session.length < 8) { session = uuid(); try { sessionStorage.setItem("wsa_session", session); } catch (e) {} }
  qs += "&visitor_id=" + encodeURIComponent(visitor) + "&session_id=" + encodeURIComponent(session);

  var msgs = document.getElementById("msgs");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var typing = document.getElementById("typing");
  var handoff = document.getElementById("handoff");
  var convId = null;
  var lastRendered = "";
  var timer = null;

  function fmtTime(iso) {
    try { var d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function addMsg(role, content, iso) {
    var div = document.createElement("div");
    div.className = "msg " + (role === "USER" ? "user" : "assistant");
    var span = document.createElement("span");
    span.textContent = content;
    div.appendChild(span);
    var t = document.createElement("span");
    t.className = "time";
    t.textContent = fmtTime(iso);
    div.appendChild(t);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function render(messages, status) {
    var sig = JSON.stringify(messages) + "|" + status;
    if (sig === lastRendered) return;
    lastRendered = sig;
    msgs.innerHTML = "";
    if (!messages.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = ${JSON.stringify(welcome)};
      msgs.appendChild(e);
    }
    (messages || []).forEach(function (m) { addMsg(m.role, m.content, m.created_at); });
    handoff.classList.toggle("show", status === "HANDOFF");
    msgs.scrollTop = msgs.scrollHeight;
  }
  async function loadConversation() {
    try {
      var r = await fetch("/api/widget/conversation?" + qs + (convId ? "&conversation_id=" + encodeURIComponent(convId) : ""));
      if (!r.ok) return;
      var j = await r.json();
      convId = j.conversation_id || convId;
      render(j.messages, j.status);
    } catch (e) { /* hors ligne : on réessaiera au prochain cycle */ }
  }
  function setTyping(on) { typing.classList.toggle("show", on); }
  async function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMsg("USER", text, new Date().toISOString());
    setTyping(true);
    sendBtn.disabled = true;
    try {
      var r = await fetch("/api/widget/send?" + qs, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convId, message: text }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 429) { addMsg("ASSISTANT", j.error || "Trop de messages — merci d'attendre un instant.", new Date().toISOString()); }
      else if (j.reply) { addMsg("ASSISTANT", j.reply, new Date().toISOString()); convId = j.conversation_id || convId; }
      else if (j.error) { addMsg("ASSISTANT", j.error, new Date().toISOString()); }
      if (j.status === "HANDOFF") handoff.classList.add("show");
    } catch (e) {
      addMsg("ASSISTANT", "Erreur de connexion. Réessayez dans un instant.", new Date().toISOString());
    }
    setTyping(false);
    sendBtn.disabled = false;
    input.focus();
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  loadConversation();
  // Polling léger (5 s) : messages humains / réponses approuvées (HYBRID)
  timer = setInterval(function () { if (!document.hidden) loadConversation(); }, 5000);
  input.focus();
})();
</script>
` : `
<div class="invalid">
  <h1>Widget introuvable</h1>
  <p>Aucun widget n'est associé à cette clé. Vérifiez l'URL d'intégration
  (le paramètre <code>/?k=…</code> doit être la clé publique du widget,
  disponible dans <em>Paramètres → Canaux → Webchat</em>).</p>
</div>
`}
</body>
</html>`;
}
