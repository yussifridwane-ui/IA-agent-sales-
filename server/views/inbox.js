// server/views/inbox.js — Phase 6 : page /dashboard/inbox (Boîte de réception unifiée)
// Liste des conversations omnicanal + filtres + détail (messages, réponses
// suggérées HYBRID, réponse humaine, assignation, mode, marquage lu).
import { esc } from "../security.js";
import { appLayout } from "./app.js";

const CHANNEL_ICONS = { WEBCHAT: "💬", EMAIL: "✉️", WHATSAPP: "🟢", FACEBOOK_MESSENGER: "📘", INSTAGRAM: "📸", SMS: "📱" };
const MODE_LABELS = { AI: "🤖 IA", HUMAN: "👤 Humain", HYBRID: "🤝 Hybride" };
const PRIORITY_STYLE = { URGENT: "#dc2626", HIGH: "#f59e0b", MEDIUM: "#3b82f6", LOW: "#64748b" };
const MODE_FILTER = ["AI", "HUMAN", "HYBRID"].includes;

export function inboxPage({ user, org, role, path, csrf, counts, members }) {
  const canWrite = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(role);
  const memberOptions = members.map((m) => `<option value="${esc(m.id)}">${esc(`${m.first_name} ${m.last_name}`)}</option>`).join("");
  const tab = (f, label, icon) => `<button class="inbox-tab" data-filter="${f}" type="button">${icon} ${label} <span class="inbox-count" data-count="${f}">${counts[f] ?? 0}</span></button>`;
  const content = `
<style>
  .inbox-wrap { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 16px; align-items: start; }
  @media (max-width: 1000px) { .inbox-wrap { grid-template-columns: 1fr; } }
  .inbox-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .inbox-tab { border: 1px solid var(--border, #e2e8f0); background: var(--card, #fff); border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--text, #0f172a); }
  .inbox-tab.active { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  .inbox-count { opacity: .75; font-size: 12px; }
  .conv-item { padding: 12px; border: 1px solid var(--border, #e2e8f0); border-radius: 12px; margin-bottom: 8px; cursor: pointer; background: var(--card, #fff); }
  .conv-item.active { border-color: #4f46e5; box-shadow: 0 0 0 2px color-mix(in srgb, #4f46e5 25%, transparent); }
  .conv-item .row1 { display: flex; align-items: center; gap: 8px; }
  .conv-item .nm { font-weight: 600; font-size: 14px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv-item .last { font-size: 12.5px; color: var(--muted, #64748b); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv-item .meta { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; font-size: 11.5px; }
  .pill { padding: 2px 8px; border-radius: 999px; background: var(--soft, #f1f5f9); color: var(--text, #0f172a); }
  .unread-dot { width: 9px; height: 9px; border-radius: 50%; background: #4f46e5; flex: none; }
  .inbox-msg { max-width: 80%; padding: 10px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 8px; }
  .inbox-msg.USER { background: #4f46e5; color: #fff; margin-left: auto; border-bottom-right-radius: 4px; }
  .inbox-msg.ASSISTANT { background: var(--soft, #f1f5f9); border: 1px solid var(--border, #e2e8f0); border-bottom-left-radius: 4px; }
  .inbox-msg .m-meta { display: block; font-size: 10.5px; opacity: .65; margin-top: 4px; }
  .sugg { border: 1px dashed #a5b4fc; background: color-mix(in srgb, #4f46e5 6%, transparent); border-radius: 12px; padding: 12px; margin: 10px 0; }
  .sugg .s-content { font-size: 13.5px; margin: 8px 0; white-space: pre-wrap; }
  .sugg .s-actions { display: flex; gap: 8px; }
  .inbox-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .inbox-detail-head h3 { margin: 0; flex: 1; }
  .inbox-controls { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .inbox-controls select, .inbox-controls input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border, #e2e8f0); background: var(--card, #fff); color: var(--text, #0f172a); font-size: 13px; }
  .inbox-reply { display: flex; gap: 8px; margin-top: 14px; }
  .inbox-reply textarea { flex: 1; min-height: 64px; border-radius: 10px; border: 1px solid var(--border, #e2e8f0); padding: 10px; font-size: 13.5px; resize: vertical; background: var(--card, #fff); color: var(--text, #0f172a); font-family: inherit; }
  .inbox-empty { text-align: center; color: var(--muted, #64748b); padding: 40px 10px; font-size: 14px; }
  .handoff-banner { background: #fef3c7; color: #92400e; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin: 10px 0; }
</style>
<div class="inbox-wrap">
  <section class="card" style="padding:16px">
    <h3 style="margin:0 0 12px">Boîte de réception</h3>
    <div class="inbox-tabs">
      ${tab("ALL", "Tous", "📥")}
      ${tab("UNREAD", "Non lus", "🔵")}
      ${tab("ASSIGNED", "À moi", "👤")}
      ${tab("AI", "IA", "🤖")}
      ${tab("HUMAN", "Humain", "👥")}
      ${tab("HYBRID", "Hybride", "🤝")}
      ${tab("HOT", "Leads chauds", "🔥")}
      ${tab("URGENT", "Urgents", "🚨")}
    </div>
    <div id="conv-list"><p class="muted-sm">Chargement…</p></div>
  </section>
  <section class="card" style="padding:16px; min-height: 320px">
    <div id="inbox-detail"><div class="inbox-empty">Sélectionnez une conversation pour voir les messages, répondre, et gérer les réponses suggérées.</div></div>
  </section>
</div>
<script>
(function () {
  "use strict";
  var CSRF = ${JSON.stringify(csrf)};
  var CAN_WRITE = ${JSON.stringify(canWrite)};
  var MEMBER_OPTIONS = ${JSON.stringify(memberOptions)};
  var ICONS = ${JSON.stringify(CHANNEL_ICONS)};
  var MODE_LABELS = ${JSON.stringify(MODE_LABELS)};
  var PRIORITY = ${JSON.stringify(PRIORITY_STYLE)};
  var currentFilter = "ALL";
  var currentConv = null;
  var detailTimer = null;

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" } }, opts || {})).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function escHtml(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function time(iso) { try { var d = new Date(iso); var sameDay = d.toDateString() === new Date().toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }

  function loadList() {
    return api("/api/inbox?filter=" + encodeURIComponent(currentFilter)).then(function (j) {
      var el = document.getElementById("conv-list");
      document.querySelectorAll(".inbox-count").forEach(function (c) {
        var f = c.dataset.count;
        if (f === "ALL") c.textContent = j.count + (currentFilter === "ALL" ? "" : "");
      });
      if (!j.conversations || !j.conversations.length) { el.innerHTML = '<p class="inbox-empty">Aucune conversation dans ce filtre.</p>'; return; }
      el.innerHTML = j.conversations.map(function (c) {
        var pr = PRIORITY[c.priority] || PRIORITY.LOW;
        return '<div class="conv-item' + (currentConv === c.id ? " active" : "") + '" data-id="' + escHtml(c.id) + '">' +
          '<div class="row1">' + (c.unread_count > 0 ? '<span class="unread-dot" title="' + c.unread_count + ' non lu(s)"></span>' : "") +
          '<span class="nm">' + (ICONS[c.channel] || "💬") + " " + escHtml(c.name) + "</span>" +
          '<span style="font-size:11px;color:' + pr + ';font-weight:600">' + c.priority + "</span></div>" +
          '<div class="last">' + escHtml(c.last_direction === "INBOUND" ? "→ " : "← ") + escHtml(c.last_message) + " <span style='opacity:.7'>· " + time(c.last_message_at) + "</span></div>" +
          '<div class="meta">' +
          '<span class="pill">' + (ICONS[c.channel] || "") + " " + escHtml(c.channel) + "</span>" +
          '<span class="pill">' + (MODE_LABELS[c.handling_mode] || c.handling_mode) + "</span>" +
          (c.score != null ? '<span class="pill" title="Score du lead">Score ' + c.score + "</span>" : "") +
          (c.intent ? '<span class="pill" title="Dernière intention">' + escHtml(c.intent) + "</span>" : "") +
          (c.assignee_name ? '<span class="pill" title="Assignée à">' + escHtml(c.assignee_name) + "</span>" : "") +
          (c.suggested_pending > 0 ? '<span class="pill" style="background:#eef2ff;color:#4f46e5">💡 ' + c.suggested_pending + " suggestion(s)</span>" : "") +
          "</div></div>";
      }).join("");
      el.querySelectorAll(".conv-item").forEach(function (it) {
        it.addEventListener("click", function () { openConversation(it.dataset.id); });
      });
    });
  }

  function openConversation(id) {
    currentConv = id;
    document.querySelectorAll(".conv-item").forEach(function (it) { it.classList.toggle("active", it.dataset.id === id); });
    api("/api/inbox/conversations/" + id).then(renderDetail).catch(function () {});
    // marque comme lue (lecture seule non bloquante)
    if (CAN_WRITE) api("/api/inbox/conversations/" + id + "/read", { method: "POST", body: JSON.stringify({}) }).then(function () {});
  }

  function renderDetail(j) {
    var el = document.getElementById("inbox-detail");
    var c = j.conversation;
    var handoff = c.status === "HANDOFF" ? '<div class="handoff-banner">👤 Conversation en transfert humain — un conseiller doit répondre (tâche + notification créées).</div>' : "";
    var msgs = (j.messages || []).map(function (m) {
      var meta = m.metadata || {};
      var extra = [];
      if (meta.intent) extra.push("intention : " + meta.intent);
      if (m.delivery_status) extra.push(m.delivery_status);
      if (m.channel && m.channel !== c.channel) extra.push(m.channel);
      return '<div class="inbox-msg ' + (m.role === "USER" ? "USER" : "ASSISTANT") + '">' + escHtml(m.content) +
        '<span class="m-meta">' + time(m.created_at) + (extra.length ? " · " + escHtml(extra.join(" · ")) : "") + "</span></div>";
    }).join("");
    var suggs = (j.suggested_replies || []).map(function (s) {
      return '<div class="sugg" data-sugg-id="' + escHtml(s.id) + '">' +
        '<div style="font-size:12px;font-weight:600;color:#4f46e5">💡 Réponse suggérée par l\'IA ' + (s.confidence != null ? "(confiance " + s.confidence + "/100)" : "") + "</div>" +
        (s.rationale ? '<div style="font-size:11.5px;color:var(--muted,#64748b)">' + escHtml(s.rationale) + "</div>" : "") +
        '<div class="s-content">' + escHtml(s.content) + "</div>" +
        (CAN_WRITE ? '<div class="s-actions">' +
          '<button class="btn primary" data-act="edit-approve" data-id="' + escHtml(s.id) + '">✏️ Éditer & approuver</button>' +
          '<button class="btn ghost" data-act="reject" data-id="' + escHtml(s.id) + '">Rejeter</button>' +
          "</div>" : '<div class="muted-sm">En attente d\'approbation par un agent.</div>') +
        "</div>";
    }).join("");
    var lead = j.lead ? '<div class="muted-sm" style="margin-top:10px">Lead : <b>' + escHtml(j.lead.name) + "</b> · score " + (j.lead.score != null ? j.lead.score : "—") +
      " · " + escHtml(j.lead.status || "") + (j.lead.next_best_action ? " · NBA : " + escHtml(j.lead.next_best_action) : "") +
      (j.lead.phone ? " · " + escHtml(j.lead.phone) : "") + (j.lead.email ? " · " + escHtml(j.lead.email) : "") + "</div>" : "";
    var summary = j.summary && (j.summary.besoin || (j.summary.objections && j.summary.objections.length)) ?
      '<div class="muted-sm" style="margin-top:8px">Résumé (mode humain) : besoin ' + escHtml(j.summary.besoin || "—") +
      (j.summary.budget != null ? " · budget " + j.summary.budget : "") +
      (j.summary.objections && j.summary.objections.length ? " · objections " + escHtml(j.summary.objections.join(", ")) : "") +
      (j.summary.urgence ? " · ⚡ urgent" : "") + " · " + j.summary.message_count + " messages</div>" : "";
    el.innerHTML =
      '<div class="inbox-detail-head"><h3>' + (ICONS[c.channel] || "💬") + " " + escHtml(c.name) + "</h3>" +
      '<span class="pill">' + escHtml(c.channel) + "</span>" +
      '<span class="pill">' + (MODE_LABELS[c.handling_mode] || c.handling_mode) + "</span>" +
      (c.priority ? '<span class="pill" style="color:' + (PRIORITY[c.priority] || "") + '">' + c.priority + "</span>" : "") +
      (c.unread_count > 0 ? '<span class="pill">' + c.unread_count + " non lu(s)</span>" : "") + "</div>" +
      handoff + lead + summary +
      (CAN_WRITE ? '<div class="inbox-controls">' +
        '<label class="muted-sm">Assigné à <select id="in-assign"><option value="">—</option>' + MEMBER_OPTIONS + "</select></label>" +
        '<label class="muted-sm">Mode <select id="in-mode">' + ["AI", "HUMAN", "HYBRID"].map(function (m) { return '<option value="' + m + '"' + (c.handling_mode === m ? " selected" : "") + ">" + MODE_LABELS[m] + "</option>"; }).join("") + "</select></label>" +
        '<label class="muted-sm">Statut <select id="in-status">' + ["ACTIVE", "RESOLVED", "HANDOFF"].map(function (s) { return '<option value="' + s + '"' + (c.status === s ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></label>" +
        '<button class="btn ghost" id="in-save">Enregistrer</button>' +
        "</div>" : "") +
      '<div style="border-top:1px solid var(--border,#e2e8f0);margin-top:8px;padding-top:12px">' + (suggs || (c.suggested_pending > 0 ? "" : "")) + (msgs || '<div class="inbox-empty">Aucun message.</div>') + "</div>" +
      (CAN_WRITE ? '<div class="inbox-reply"><textarea id="in-reply" placeholder="Répondre ' + (c.channel === "WEBCHAT" ? "au visiteur" : "au client") + " (envoi " + (c.channel === "WEBCHAT" ? "dans le chat" : "réel sur " + c.channel) + ")…"></textarea><button class="btn primary" id="in-send">Envoyer</button></div>" :
      '<p class="muted-sm" style="margin-top:12px">Votre rôle est en lecture seule — vous ne pouvez pas répondre.</p>');
    bindDetail(c);
  }

  function bindDetail(c) {
    var saveBtn = document.getElementById("in-save");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var body = {
        assigned_to: document.getElementById("in-assign").value || null,
        handling_mode: document.getElementById("in-mode").value,
        status: document.getElementById("in-status").value,
      };
      api("/api/inbox/conversations/" + c.id, { method: "PUT", body: JSON.stringify(body) }).then(function (j) { alert(j.message || (j.error || "OK")); loadList(); openConversation(c.id); });
    });
    var sendBtn = document.getElementById("in-send");
    if (sendBtn) sendBtn.addEventListener("click", function () {
      var ta = document.getElementById("in-reply");
      var message = ta.value.trim();
      if (!message) return;
      api("/api/inbox/conversations/" + c.id + "/reply", { method: "POST", body: JSON.stringify({ message }) }).then(function (j) {
        if (j.error) alert(j.message || j.error);
        ta.value = "";
        openConversation(c.id); loadList();
      });
    });
    document.querySelectorAll(".sugg [data-act]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.id;
        var content = null;
        if (b.dataset.act === "edit-approve") {
          var box = b.closest(".sugg").querySelector(".s-content");
          content = window.prompt("Éditer la réponse avant envoi :", box.textContent);
          if (content === null) return;
        }
        api("/api/inbox/suggested/" + id + "/" + b.dataset.act, { method: "POST", body: JSON.stringify(content ? { content } : {}) }).then(function (j) {
          alert(j.message || j.error || "OK");
          openConversation(c.id); loadList();
        });
      });
    });
  }

  document.querySelectorAll(".inbox-tab").forEach(function (t) {
    t.addEventListener("click", function () {
      currentFilter = t.dataset.filter;
      document.querySelectorAll(".inbox-tab").forEach(function (x) { x.classList.toggle("active", x === t); });
      loadList();
    });
  });
  document.querySelector('.inbox-tab[data-filter="ALL"]').classList.add("active");
  loadList();
  // Rafraîchissement léger de la liste (30 s) pour les nouveaux messages
  setInterval(function () { if (!document.hidden) loadList(); }, 30000);
})();
</script>`;
  return appLayout({ title: "Boîte de réception", user, org, role, path, csrf, content });
}
