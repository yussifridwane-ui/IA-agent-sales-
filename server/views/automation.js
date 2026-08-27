// server/views/automation.js — Phase 5 : pages du moteur d'automatisation
import { esc } from "../security.js";
import { appLayout } from "./app.js";

const AUTOMATION_STATUS = { DRAFT: "Brouillon", ACTIVE: "Active", PAUSED: "Pause", ARCHIVED: "Archivée" };
const SEQUENCE_STATUS = { DRAFT: "Brouillon", ACTIVE: "Active", PAUSED: "Pause", ARCHIVED: "Archivée" };
const CAMP_STATUS = { DRAFT: "Brouillon", ACTIVE: "Active", COMPLETED: "Terminée", PAUSED: "Pause" };
const FOLLOWUP_STATUS = { SCHEDULED: "Planifié", PENDING_APPROVAL: "À valider", DRAFTED: "Préparé", SENT: "Envoyé", FAILED: "Échec", CANCELLED: "Annulé" };
const FOLLOWUP_STATUS_COLORS = { SCHEDULED: "#0284c7", PENDING_APPROVAL: "#d97706", DRAFTED: "#7c3aed", SENT: "#16a34a", FAILED: "#dc2626", CANCELLED: "#64748b" };
const ACTION_LABELS = {
  CREATE_TASK: "Créer une tâche", UPDATE_LEAD: "Modifier le lead", UPDATE_SCORE: "Modifier le score",
  ADD_NOTE: "Ajouter une note", CREATE_ACTIVITY: "Créer une activité", SEND_EMAIL: "Envoyer un e-mail",
  SEND_MESSAGE: "Envoyer un message", ASSIGN_LEAD: "Assigner le lead", CREATE_DEAL: "Créer un deal",
  NOTIFY_SALES_AGENT: "Notifier le commercial", HANDOFF_HUMAN: "Transmettre à un humain",
  START_SEQUENCE: "Démarrer une séquence", STOP_SEQUENCE: "Arrêter les séquences",
};

function statusBadge(s, map) {
  const colors = { DRAFT: "#64748b", ACTIVE: "#16a34a", PAUSED: "#d97706", ARCHIVED: "#94a3b8", COMPLETED: "#16a34a" };
  const c = colors[s] || "#64748b";
  return `<span class="badge-l" style="background:color-mix(in srgb, ${c} 14%, transparent); color:${c}">${esc(map[s] || s)}</span>`;
}

function followupBadge(s) {
  const c = FOLLOWUP_STATUS_COLORS[s] || "#64748b";
  return `<span class="badge-l" style="background:color-mix(in srgb, ${c} 14%, transparent); color:${c}">${esc(FOLLOWUP_STATUS[s] || s)}</span>`;
}

function conditionsHtml(conditions) {
  if (!conditions?.length) return "<span class='muted-sm'>Toujours (aucune condition)</span>";
  return conditions.map((c) => `<span class="chip">${esc(c.field)} <b>${esc(c.operator)}</b> ${esc(Array.isArray(c.value) ? c.value.join(", ") : c.value)}</span>`).join(" ");
}
function actionsHtml(actions) {
  if (!actions?.length) return "—";
  return actions.map((a) => `<span class="chip">${esc(ACTION_LABELS[a.action] || a.action)}${a.delay_minutes ? ` <small>(+${a.delay_minutes} min)</small>` : ""}</span>`).join(" ");
}

/* ============================ AUTOMATIONS ============================ */
export function automationsPage(ctx, { automations, channels, followup_mode, EVENT_TYPES, CONDITIONS_FIELDS, OPERATORS, ACTIONS }) {
  const { user, org, role, csrf } = ctx;
  const rows = automations.map((a) => {
    const conditions = JSON.parse(a.conditions || "[]");
    const actions = JSON.parse(a.actions || "[]");
    return `<tr>
      <td class="strong">${esc(a.name)}${a.description ? `<div class="muted-sm">${esc(a.description)}</div>` : ""}</td>
      <td><code class="chip">${esc(a.trigger)}</code></td>
      <td>${conditionsHtml(conditions)}</td>
      <td>${actionsHtml(actions)}</td>
      <td>${statusBadge(a.status, AUTOMATION_STATUS)}</td>
      <td class="nowrap">
        ${a.status === "ACTIVE" ? `<button class="btn small ghost" data-fetch-action="/api/automations/${a.id}/pause" data-method="POST">Pause</button>` : `<button class="btn small primary" data-fetch-action="/api/automations/${a.id}/activate" data-method="POST">Activer</button>`}
        <button class="btn small ghost" data-fetch-action="/api/automations/${a.id}" data-method="POST" data-confirm="Supprimer cette automation ?">Supprimer</button>
      </td>
    </tr>`;
  }).join("");
  const canManage = ["OWNER", "ADMIN", "MANAGER"].includes(role);
  return appLayout({
    title: "Automations", user, org, role, path: "/dashboard/automations", csrf,
    content: `
  <section class="page-head">
    <div><h2>Automations</h2><p class="muted">WHEN → IF → THEN : déclencher des actions selon les événements commerciaux. Mode d'envoi actuel : <b>${esc(followup_mode === "AUTO" ? "automatique" : followup_mode === "APPROVAL_REQUIRED" ? "validation commerciale requise" : "manuel")}</b>.</p></div>
  </section>
  ${canManage ? `
  <div class="card" id="autoBuilder" style="margin-bottom:16px">
    <h3 style="margin:0 0 12px">Nouvelle automation</h3>
    <div class="builder-row">
      <div class="field"><label>Nom</label><input type="text" id="ab-name" maxlength="120" required placeholder="Ex. Relance lead chaud"/></div>
      <div class="field"><label>DÉCLENCHEUR (WHEN)</label>
        <select id="ab-trigger" required>${EVENT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
      </div>
    </div>
    <div class="builder-conditions">
      <div class="builder-label">CONDITIONS (IF) — toutes doivent être remplies</div>
      <div id="ab-conditions"></div>
      <button type="button" class="btn small ghost" id="ab-add-cond">+ Condition</button>
    </div>
    <div class="builder-actions">
      <div class="builder-label">ACTIONS (THEN)</div>
      <div id="ab-actions"></div>
      <button type="button" class="btn small ghost" id="ab-add-action">+ Action</button>
    </div>
    <div style="margin-top:12px">
      <button type="button" class="btn primary" id="ab-create">Créer l'automation</button>
      <span class="muted-sm">Les actions sensibles sont protégées par permissions, opt-out et limites anti-spam.</span>
    </div>
  </div>` : ""}
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Automation</th><th>Quand</th><th>Si</th><th>Alors</th><th>Statut</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">Aucune automation. Créez-en une (WHEN → IF → THEN).</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 8px">Canaux de communication</h3>
    <p class="muted-sm">Seuls les canaux connectés peuvent envoyer. Les autres échouent honnêtement (« Canal non configuré. ») — aucun envoi simulé.</p>
    <div class="builder-row" style="flex-wrap:wrap;gap:8px">
      ${Object.entries(channels).map(([c, s]) => `<span class="chip" style="color:${s.configured ? "#16a34a" : "#64748b"}">${c} : ${s.configured ? "connecté" : "non configuré"}</span>`).join("")}
    </div>
  </div>`,
  });
}

/* ============================ SÉQUENCES ============================ */
export function sequencesPage(ctx, { sequences, enrollments, CHANNELS }) {
  const { user, org, role, csrf } = ctx;
  const rows = sequences.map((s) => {
    const steps = JSON.parse(s.steps || "[]");
    return `<tr>
      <td class="strong">${esc(s.name)}<div class="muted-sm">${steps.length} étape(s) · ${esc(s.channel)}</div></td>
      <td>${steps.map((st, i) => `<span class="chip">${i + 1}. ${esc(st.wait || "1d")} — ${esc(String(st.subject || st.content || "").slice(0, 40))}…</span>`).join(" ")}</td>
      <td>${statusBadge(s.status, SEQUENCE_STATUS)}</td>
      <td class="nowrap">
        ${s.status === "ACTIVE" ? `<button class="btn small ghost" data-fetch-action="/api/sequences/${s.id}/start" data-method="POST" data-lead-select="1">Inscrire des leads…</button>` : `<button class="btn small primary" data-fetch-action="/api/sequences/${s.id}" data-method="PUT" data-payload='{"status":"ACTIVE"}'>Activer</button>`}
      </td>
    </tr>`;
  }).join("");
  const enrollRows = enrollments.slice(0, 30).map((e) => {
    const seq = sequences.find((s) => s.id === e.sequence_id);
    return `<tr><td>${esc(seq?.name || "—")}</td><td>${esc(e.status)}${e.stop_reason ? ` <span class="muted-sm">(${esc(e.stop_reason)})</span>` : ""}</td><td>${e.current_step + 1}/${esc(seq ? JSON.parse(seq.steps || "[]").length : "?")}</td><td class="muted-sm">${esc(e.enrolled_at?.slice(0, 10))}</td></tr>`;
  }).join("");
  const canManage = ["OWNER", "ADMIN", "MANAGER"].includes(role);
  return appLayout({
    title: "Séquences", user, org, role, path: "/dashboard/sequences", csrf,
    content: `
  <section class="page-head"><div><h2>Séquences commerciales</h2><p class="muted">Step 1 → Wait → Step 2 → … → Stop. Arrêt automatique : réponse du client, lead WON/LOST, prise en main humaine, opt-out, deal clos.</p></div></section>
  ${canManage ? `
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin:0 0 12px">Nouvelle séquence</h3>
    <div class="builder-row">
      <div class="field"><label>Nom</label><input type="text" id="seq-name" maxlength="120" required placeholder="Ex. Relance prospection"/></div>
      <div class="field"><label>Canal</label><select id="seq-channel">${CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
    </div>
    <div class="builder-label">ÉtAPES</div>
    <div id="seq-steps"></div>
    <button type="button" class="btn small ghost" id="seq-add-step">+ Étape</button>
    <div style="margin-top:12px"><button type="button" class="btn primary" id="seq-create">Créer la séquence</button></div>
  </div>` : ""}
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Séquence</th><th>Étapes</th><th>Statut</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">Aucune séquence.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 8px">Inscriptions récentes</h3>
    <table class="tbl">
      <thead><tr><th>Séquence</th><th>Statut</th><th>Étape</th><th>Inscrit le</th></tr></thead>
      <tbody>${enrollRows || `<tr><td colspan="4" class="muted">Aucune inscription.</td></tr>`}</tbody>
    </table>
  </div>`,
  });
}

/* ============================ CAMPAGNES ============================ */
export function campaignsPage(ctx, { campaigns, segments, templates, CHANNELS }) {
  const { user, org, role, csrf } = ctx;
  const rows = campaigns.map((c) => `<tr>
    <td class="strong">${esc(c.name)}</td>
    <td>${esc(segments.find((s) => s.id === c.segment_id)?.name || "—")}</td>
    <td>${esc(c.channel)}</td>
    <td>${c.status === "DRAFT" ? "—" : `${c.sent_count}/${c.recipients_count}`}</td>
    <td>${statusBadge(c.status, CAMP_STATUS)}</td>
    <td class="nowrap">${c.status === "DRAFT" ? `<button class="btn small primary" data-fetch-action="/api/campaigns/${c.id}/start" data-method="POST">Démarrer</button>` : ""}</td>
  </tr>`).join("");
  const canManage = ["OWNER", "ADMIN", "MANAGER"].includes(role);
  return appLayout({
    title: "Campagnes", user, org, role, path: "/dashboard/campaigns", csrf,
    content: `
  <section class="page-head"><div><h2>Campagnes</h2><p class="muted">Cibler un segment (leads), envoyer un template sur un canal. Respecte opt-out et limites anti-spam.</p></div></section>
  ${canManage ? `
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin:0 0 12px">Nouvelle campagne</h3>
    <div class="builder-row" style="flex-wrap:wrap">
      <div class="field"><label>Nom</label><input type="text" id="camp-name" maxlength="120" required placeholder="Ex. Relance leads froids août"/></div>
      <div class="field"><label>Segment</label><select id="camp-segment" required>${segments.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("") || `<option value="">— créez un segment d'abord —</option>`}</select></div>
      <div class="field"><label>Template</label><select id="camp-template" required>${templates.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.channel)})</option>`).join("") || `<option value="">— créez un template d'abord —</option>`}</select></div>
      <div class="field"><label>Canal</label><select id="camp-channel">${CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
    </div>
    <div><button type="button" class="btn primary" id="camp-create">Créer la campagne (brouillon)</button></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin:0 0 12px">Segments & templates</h3>
    <div class="builder-row" style="flex-wrap:wrap;align-items:end;gap:12px">
      <div class="field"><label>Nouveau segment (nom)</label><input type="text" id="seg-name" maxlength="120" placeholder="Ex. Leads chauds non contactés"/></div>
      <div class="field"><label>Score min</label><input type="number" id="seg-score" min="0" max="100" placeholder="ex. 80"/></div>
      <div class="field"><label>Statut (HOT, QUALIFIED…)</label><input type="text" id="seg-status" placeholder="ex. HOT"/></div>
      <div class="field"><label>Max jours sans activité</label><input type="number" id="seg-days" min="1" placeholder="ex. 30"/></div>
      <button type="button" class="btn" id="seg-create">Créer le segment</button>
    </div>
    <div class="builder-row" style="flex-wrap:wrap;align-items:end;gap:12px;margin-top:12px">
      <div class="field"><label>Template (nom)</label><input type="text" id="tpl-name" maxlength="120" placeholder="Ex. Relance polie"/></div>
      <div class="field" style="flex:1"><label>Contenu (variables : {{first_name}}, {{product_name}}, {{company_name}}, {{deal_value}}, {{sales_agent}})</label><textarea id="tpl-content" rows="2" required placeholder="Bonjour {{first_name}}, …"></textarea></div>
      <div class="field"><label>Canal</label><select id="tpl-channel">${CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
      <button type="button" class="btn" id="tpl-create">Créer le template</button>
    </div>
  </div>` : ""}
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Campagne</th><th>Segment</th><th>Canal</th><th>Envoyés</th><th>Statut</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">Aucune campagne.</td></tr>`}</tbody>
    </table>
  </div>`,
  });
}

/* ============================ FOLLOW-UPS ============================ */
export function followupsPage(ctx, { pending, history, followup_mode, CHANNELS }) {
  const { user, org, role, csrf } = ctx;
  const canWrite = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(role);
  const pendRows = pending.map((f) => `<tr>
    <td class="muted-sm">${esc((f.scheduled_at || "").slice(0, 16).replace("T", " "))}</td>
    <td>${esc(f.channel)}${f.sequence_id ? " <span class='muted-sm'>(séquence)</span>" : ""}</td>
    <td class="strong">${esc(String(f.message || "").slice(0, 90))}…</td>
    <td>${followupBadge(f.status)}</td>
    <td class="nowrap">
      ${f.status === "PENDING_APPROVAL" && canWrite ? `<button class="btn small primary" data-fetch-action="/api/followups/${f.id}/approve" data-method="POST">Valider + envoyer</button>` : ""}
      ${canWrite ? `<button class="btn small ghost" data-fetch-action="/api/followups/${f.id}/cancel" data-method="POST" data-confirm="Annuler ce follow-up ?">Annuler</button>` : ""}
    </td>
  </tr>`).join("");
  const histRows = history.filter((f) => ["SENT", "FAILED", "CANCELLED"].includes(f.status)).slice(0, 40).map((f) => `<tr>
    <td class="muted-sm">${esc((f.created_at || "").slice(0, 16).replace("T", " "))}</td>
    <td>${esc(f.channel)}</td>
    <td>${esc(String(f.message || "").slice(0, 80))}…</td>
    <td>${followupBadge(f.status)}${f.cancel_reason ? ` <span class="muted-sm">${esc(f.cancel_reason)}</span>` : ""}${f.error ? ` <span class="muted-sm">${esc(f.error)}</span>` : ""}${f.response_at ? ` <span class="muted-sm">↳ réponse</span>` : ""}</td>
  </tr>`).join("");
  return appLayout({
    title: "Follow-ups", user, org, role, path: "/dashboard/followups", csrf,
    content: `
  <section class="page-head"><div><h2>Follow-ups</h2><p class="muted">Mode : <b>${esc(followup_mode === "AUTO" ? "automatique" : followup_mode === "APPROVAL_REQUIRED" ? "validation commerciale requise" : "manuel (IA prépare le message)")}</b>. Arrêt auto : réponse du client, lead clos, prise en main humaine, opt-out.</p></div></section>
  ${canWrite ? `
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin:0 0 12px">Planifier une relance</h3>
    <div class="builder-row" style="flex-wrap:wrap">
      <div class="field"><label>Lead ID</label><input type="text" id="fu-lead" placeholder="uuid du lead" required/></div>
      <div class="field"><label>Canal</label><select id="fu-channel">${CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
      <div class="field"><label>Délai</label><select id="fu-wait">
        <option value="immediate">immédiat</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option>
        <option value="1h">1 heure</option><option value="1d">1 jour</option><option value="2d">2 jours</option>
        <option value="3d">3 jours</option><option value="7d">7 jours</option>
      </select></div>
    </div>
    <div class="field"><label>Message</label><textarea id="fu-message" rows="2" required placeholder="Bonjour {{first_name}}, …"></textarea></div>
    <div style="margin-top:8px"><button type="button" class="btn primary" id="fu-create">Planifier</button> <span class="muted-sm">Business hours et timezone de l'organisation appliquées automatiquement.</span></div>
  </div>` : ""}
  <div class="card">
    <h3 style="margin:0 0 8px">En attente</h3>
    <table class="tbl">
      <thead><tr><th>Prévu le</th><th>Canal</th><th>Message</th><th>Statut</th><th></th></tr></thead>
      <tbody>${pendRows || `<tr><td colspan="5" class="muted">Aucun follow-up en attente.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 8px">Historique</h3>
    <table class="tbl">
      <thead><tr><th>Date</th><th>Canal</th><th>Message</th><th>Résultat</th></tr></thead>
      <tbody>${histRows || `<tr><td colspan="4" class="muted">Aucun historique.</td></tr>`}</tbody>
    </table>
  </div>`,
  });
}

/* ============================ ANALYTICS AUTOMATION ============================ */
export function automationAnalyticsPage(ctx, { analytics, readiness }) {
  const { user, org, role, csrf } = ctx;
  const a = analytics;
  const noData = !a.has_data;
  const seqRows = a.sequences.map((s) => `<tr>
    <td class="strong">${esc(s.name)}</td>
    <td>${s.contacts}</td><td>${s.sent}</td><td>${s.replied}</td><td>${s.qualified}</td><td>${s.converted}</td><td>${s.stopped}</td>
    <td>${s.response_rate === null ? "—" : `${s.response_rate} %`}</td>
    <td>${s.qualification_rate === null ? "—" : `${s.qualification_rate} %`}</td>
    <td>${s.conversion_rate === null ? "—" : `${s.conversion_rate} %`}</td>
  </tr>`).join("");
  const ds = readiness.dataset;
  return appLayout({
    title: "Analytics automation", user, org, role, path: "/dashboard/automation/analytics", csrf,
    content: `
  <section class="page-head"><div><h2>Analytics — Automatisation</h2><p class="muted">${noData ? "Données insuffisantes : les indicateurs s'afficheront dès les premières exécutions." : "Résultats mesurés (aucune statistique inventée)."}</p></div></section>
  <div class="grid-cards" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
    <div class="card stat"><div class="stat-ico">⚙️</div><div><div class="stat-value">${a.automations.executions}</div><div class="muted-sm">Automations exécutées</div></div></div>
    <div class="card stat"><div class="stat-ico">✅</div><div><div class="stat-value">${a.automations.SUCCESS}</div><div class="muted-sm">Succès</div></div></div>
    <div class="card stat"><div class="stat-ico">❌</div><div><div class="stat-value">${a.automations.FAILED}</div><div class="muted-sm">Échecs</div></div></div>
    <div class="card stat"><div class="stat-ico">✉️</div><div><div class="stat-value">${a.messages.sent}</div><div class="muted-sm">Messages envoyés</div></div></div>
    <div class="card stat"><div class="stat-ico">💬</div><div><div class="stat-value">${a.messages.replied}</div><div class="muted-sm">Réponses</div></div></div>
    <div class="card stat"><div class="stat-ico">🎯</div><div><div class="stat-value">${a.messages.total}</div><div class="muted-sm">Follow-ups</div></div></div>
    <div class="card stat"><div class="stat-ico">💰</div><div><div class="stat-value">${a.revenue_associated.total ? new Intl.NumberFormat("fr-FR").format(a.revenue_associated.total) : "—"}</div><div class="muted-sm">Revenue associé (${a.revenue_associated.deals} deal(s) WON influencé(s))</div></div></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 8px">Séquences</h3>
    <table class="tbl">
      <thead><tr><th>Séquence</th><th>Contacts</th><th>Envoyés</th><th>Répondu</th><th>Qualifiés</th><th>Convertis</th><th>Arrêtés</th><th>Taux réponse</th><th>Taux qualif.</th><th>Taux conv.</th></tr></thead>
      <tbody>${seqRows || `<tr><td colspan="10" class="muted">Aucune séquence.</td></tr>`}</tbody>
    </table>
    ${a.sequences.length && a.sequences.every((s) => s.contacts === 0) ? `<p class="muted-sm" style="margin-top:8px">Données insuffisantes (aucun contact inscrit).</p>` : ""}
  </div>
  <div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 8px">AI Prediction Readiness</h3>
    <p class="muted-sm">Le score de conversion actuel est un <b>${esc(readiness.label)}</b> — ${esc(readiness.disclaimer || "un modèle ML est actif.")}</p>
    <div class="builder-row" style="flex-wrap:wrap;gap:8px;margin:10px 0">
      <span class="chip">${ds.leads} leads</span>
      <span class="chip">${ds.deals} deals</span>
      <span class="chip">🏆 ${ds.won} won</span>
      <span class="chip">📉 ${ds.lost} lost</span>
      <span class="chip">📝 ${ds.resolved_predictions}/${ds.predictions} prédictions résolues</span>
    </div>
    <p><b>${esc(readiness.status)}</b> <span class="muted-sm">(seuil configurable : ${readiness.min_required} résultats finalisés minimum — ${esc(readiness.min_required_note)})</span></p>
    ${readiness.missing?.length ? `<ul style="margin:6px 0 0 18px">${readiness.missing.map((m) => `<li class="muted-sm">${esc(m)}</li>`).join("")}</ul>` : ""}
    <p class="muted-sm" style="margin-top:8px">Évaluation future (ML) : precision, recall, F1, ROC-AUC, PR-AUC, calibration, confusion matrix — comparées au baseline heuristique. Aucun entraînement avec des résultats non finalisés (pas de fuite temporelle).</p>
  </div>`,
  });
}
