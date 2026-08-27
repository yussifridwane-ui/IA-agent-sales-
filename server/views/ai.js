// server/views/ai.js — Phase 3 : pages du moteur IA
import { esc } from "../security.js";
import { appLayout } from "./app.js";

const STATUS_BADGE = {
  ACTIVE: '<span class="tag ok">● Active</span>',
  PAUSED: '<span class="tag warn">⏸ En pause</span>',
  DRAFT: '<span class="tag">○ Brouillon</span>',
};
const TONES = ["professional", "friendly", "direct", "premium", "consultative"];
const STYLES = ["court", "equilibre", "detaille"];
const KB_TYPE_LABELS = { TEXT: "Texte", FAQ: "FAQ", POLICY: "Politique", CONDITIONS: "Conditions", DELIVERY: "Livraison", RETURN: "Retours", WARRANTY: "Garantie", COMPANY: "Entreprise" };

function layout(ctx, title, content) {
  return appLayout({ title, user: ctx.user, org: ctx.org, role: ctx.member.role, path: ctx.path, csrf: ctx.csrf, content });
}

/* ================= PAGE AGENT ================= */
export function agentPage(ctx, { agent, rules, versions, kbCount, productCount, plan, used, quota }) {
  const pct = quota === Infinity ? 0 : Math.min(Math.round((used / quota) * 100), 100);
  return layout(ctx, "AI Sales Agent", `
  <div class="page-toolbar">
    <div>
      <h2>AI Sales Agent ${STATUS_BADGE[agent.status] || ""}</h2>
      <p class="muted">Canaux connectés : <span class="tag ok">WEBSITE_TEST</span> <span class="muted-sm">(WhatsApp, Instagram, Facebook — phases suivantes)</span></p>
    </div>
    <div class="toolbar-actions">
      <a class="btn primary" href="/dashboard/agent/playground">▶ Tester l'agent</a>
      ${agent.status !== "ACTIVE" ? '<button class="btn ghost" data-agent-status="ACTIVE">Activer</button>' : '<button class="btn ghost" data-agent-status="PAUSED">Mettre en pause</button>'}
    </div>
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>Configuration</h3><span class="muted-sm">Nom · Langue · Ton · Objectif</span></div>
      <form method="PUT" action="/api/agent/settings" data-fetch class="form" id="agentForm">
        <div class="field"><label for="a_name">Nom de l'agent</label><input id="a_name" name="name" value="${esc(agent.name)}" required maxlength="60"/></div>
        <div class="field"><label for="a_desc">Description</label><input id="a_desc" name="description" value="${esc(agent.description || "")}" maxlength="300"/></div>
        <div class="field-2col">
          <div class="field"><label for="a_lang">Langue</label><select id="a_lang" name="language">
            <option value="fr"${agent.language === "fr" ? " selected" : ""}>Français</option>
            <option value="en"${agent.language === "en" ? " selected" : ""}>Anglais</option>
            <option value="ewe" disabled>Éwé (bientôt)</option>
            <option value="kbp" disabled>Kabyè (bientôt)</option>
          </select></div>
          <div class="field"><label for="a_tone">Ton</label><select id="a_tone" name="tone">
            ${TONES.map((t) => `<option value="${t}"${agent.tone === t ? " selected" : ""}>${esc(t)}</option>`).join("")}
          </select></div>
        </div>
        <div class="field-2col">
          <div class="field"><label for="a_style">Style</label><select id="a_style" name="style">
            ${STYLES.map((s) => `<option value="${s}"${agent.style === s ? " selected" : ""}>${s === "equilibre" ? "Équilibré" : s === "court" ? "Court" : "Détaillé"}</option>`).join("")}
          </select></div>
          <div class="field"><label for="a_goal">Objectif commercial</label><input id="a_goal" name="business_goal" value="${esc(agent.business_goal || "")}" maxlength="200" placeholder="Ex. : qualifier les leads entrants"/></div>
        </div>
        <div class="field"><label for="a_welcome">Message d'accueil</label><textarea id="a_welcome" name="welcome_message" rows="2" maxlength="500">${esc(agent.welcome_message || "")}</textarea></div>
        <div class="field"><label for="a_fallback">Message de repli (information inconnue)</label><textarea id="a_fallback" name="fallback_message" rows="2" maxlength="500">${esc(agent.fallback_message || "")}</textarea></div>
        <label class="check-line"><input type="checkbox" name="human_handoff_enabled" value="1"${agent.human_handoff_enabled ? " checked" : ""}/> Transfert à un humain autorisé</label>
        <div class="form-row"><button type="submit" class="btn primary">Enregistrer</button></div>
      </form>
    </div>

    <div style="display:grid;gap:18px">
      <div class="card form-card">
        <div class="card-head"><h3>Quota IA</h3><span class="muted-sm">Plan ${esc(plan)}</span></div>
        <div class="quota-bar"><div style="width:${pct}%"></div></div>
        <p class="muted-sm">${quota === Infinity ? "Quota illimité" : `${used} / ${quota} messages ce mois (${pct} %)`}${pct >= 80 && quota !== Infinity ? ' — <b style="color:var(--warn)">vous approchez de votre quota IA</b>' : ""}</p>
        <div class="detail-lines">
          <div class="ob-line"><span>Sources de connaissance</span><b>${kbCount} document(s) KB</b></div>
          <div class="ob-line"><span>Produits accessibles</span><b>${productCount} produit(s) catalogue</b></div>
          <div class="ob-line"><span>Modèle IA</span><b>${esc(process.env.AI_API_KEY ? (process.env.AI_MODEL || "openai-compat") : "moteur local (hors-ligne)")}</b></div>
        </div>
      </div>

      <div class="card form-card">
        <div class="card-head"><h3>Règles de vente</h3><span class="muted-sm">Respectées par l'agent</span></div>
        <form method="PUT" action="/api/agent/rules" data-fetch class="form" id="rulesForm">
          <div class="field-2col">
            <div class="field"><label>Remise max. (%)</label><input type="number" name="max_discount_percent" min="0" max="100" value="${esc(rules.max_discount_percent)}"/></div>
            <div class="field"><label>Commande min. (devise org.)</label><input type="number" name="minimum_order_value" min="0" value="${esc(rules.minimum_order_value ?? "")}" placeholder="Aucun"/></div>
          </div>
          <label class="check-line"><input type="checkbox" name="negotiation_enabled" value="1"${rules.negotiation_enabled ? " checked" : ""}/> Négociation autorisée</label>
          <div class="field"><label>Modes de paiement</label><input name="payment_methods" value="${esc(rules.payment_methods || "")}" maxlength="300"/></div>
          <div class="field"><label>Informations livraison</label><textarea name="delivery_information" rows="2" maxlength="500">${esc(rules.delivery_information || "")}</textarea></div>
          <div class="field"><label>Politique de retour</label><textarea name="return_policy" rows="2" maxlength="500">${esc(rules.return_policy || "")}</textarea></div>
          <div class="form-row"><button type="submit" class="btn ghost">Enregistrer les règles</button></div>
        </form>
      </div>

      <div class="card form-card">
        <div class="card-head"><h3>Instructions métier (versionnées)</h3><span class="muted-sm">Les règles système ont toujours priorité</span></div>
        <form method="PUT" action="/api/agent/settings" data-fetch class="form" id="instructionsForm">
          <div class="field"><textarea name="instructions" rows="3" maxlength="5000" placeholder="Ex. : Insister sur la garantie 12 mois. Ne jamais proposer l'ancien modèle.">${esc(versions.find((v) => v.active)?.instructions || "")}</textarea></div>
          <div class="form-row">
            <span class="muted-sm">${versions.length ? `Version active : v${versions.find((v) => v.active)?.version ?? "—"}` : "Aucune version"}</span>
            <button type="submit" class="btn ghost">Nouvelle version</button>
          </div>
        </form>
        ${versions.length ? `<div class="detail-lines" style="margin-top:10px">${versions.slice(0, 5).map((v) => `<div class="ob-line"><span>v${v.version}</span><b>${v.active ? "active" : "archivée"} · ${esc(v.created_at.slice(0, 10))}</b></div>`).join("")}</div>` : ""}
      </div>
    </div>
  </div>
  `);
}

/* ================= PLAYGROUND ================= */
export function agentPlaygroundPage(ctx, { agent }) {
  return layout(ctx, "Playground — AI Sales Agent", `
  <div class="page-toolbar">
    <div>
      <h2>Tester l'agent <span class="muted-sm">(canal WEBSITE_TEST)</span></h2>
      <p class="muted">À gauche : la conversation. À droite : les informations IA (intention, confiance, score, produits, actions, sources).</p>
    </div>
    <div class="toolbar-actions"><button class="btn ghost" id="pgReset">↺ Nouvelle conversation</button></div>
  </div>
  ${agent.status === "PAUSED" ? `<div class="alert error">L'agent est en pause — activez-le depuis la page Agent pour tester.</div>` : ""}
  <div class="playground">
    <div class="pg-chat card">
      <div class="pg-messages" id="pgMessages">
        <div class="msg agent"><div class="bubble">${esc(agent.welcome_message || "Bonjour ! Je suis votre assistant commercial. Comment puis-je vous aider ?")}</div></div>
      </div>
      <form id="pgForm" class="pg-input">
        <input id="pgInput" type="text" placeholder="Écrivez un message… (ex : « Je cherche un ordinateur à moins de 300 000 FCFA »)" autocomplete="off"/>
        <button type="submit" class="btn primary">Envoyer</button>
      </form>
    </div>
    <div class="pg-info card">
      <h3>Informations IA</h3>
      <div id="pgInfo" class="pg-info-body muted">Envoyez un message pour analyser la réponse de l'agent.</div>
      <div class="pg-sources" id="pgSources"></div>
    </div>
  </div>
  `);
}

/* ================= KNOWLEDGE BASE ================= */
export function knowledgePage(ctx, { documents }) {
  return layout(ctx, "Knowledge Base", `
  <div class="page-toolbar">
    <div>
      <h2>Knowledge Base</h2>
      <p class="muted">Documents, FAQ, politiques, conditions, livraison, retours, garanties — la source de vérité n°3 de l'agent.</p>
    </div>
    <div class="toolbar-actions"><span class="tag ok">${documents.filter((d) => d.status === "READY").length} indexé(s)</span></div>
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>Ajouter un document</h3></div>
      <form method="POST" action="/api/knowledge/documents" data-fetch class="form" id="docForm">
        <div class="field"><label for="d_name">Nom</label><input id="d_name" name="name" placeholder="Ex. : Politique de livraison" required maxlength="120"/></div>
        <div class="field-2col">
          <div class="field"><label for="d_type">Type</label><select id="d_type" name="type">
            ${Object.entries(KB_TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select></div>
          <div class="field"><label for="d_cat">Catégorie (FAQ)</label><input id="d_cat" name="category" placeholder="Général" maxlength="60"/></div>
        </div>
        <div class="field"><label for="d_question">Question (si FAQ) <span class="muted-sm">— sinon laissez vide</span></label><input id="d_question" name="question" placeholder="Ex. : Quels sont les délais de livraison ?" maxlength="300"/></div>
        <div class="field"><label for="d_content">Contenu / Réponse</label><textarea id="d_content" name="content" rows="5" placeholder="Collez ici le texte, la réponse ou le contenu du document (PDF : texte extrait)…" required></textarea></div>
        <div class="form-row"><button type="submit" class="btn primary">Ajouter et indexer</button></div>
      </form>
      <div class="card-head" style="margin-top:16px"><h3>Tester ma Knowledge Base</h3></div>
      <form id="kbTestForm" class="form-inline">
        <input type="text" id="kbTestQuery" placeholder="Ex. : Quels sont vos délais de livraison ?" required/>
        <button type="submit" class="btn ghost">Tester le RAG</button>
      </form>
      <div id="kbTestResult" class="kb-test-result"></div>
    </div>

    <div class="card table-card">
      <div class="card-head" style="padding:14px 16px 0"><h3>Documents</h3><span class="muted-sm">${documents.length} au total</span></div>
      ${documents.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Document</th><th>Type</th><th>Statut</th><th>Chunks</th><th>Date</th><th class="right">Actions</th></tr></thead>
        <tbody>${documents.map((d) => `<tr>
          <td class="strong">${esc(d.name)}</td>
          <td>${esc(KB_TYPE_LABELS[d.type] || d.type)}</td>
          <td>${d.status === "READY" ? '<span class="tag ok">READY</span>' : d.status === "PROCESSING" ? '<span class="tag warn">PROCESSING</span>' : '<span class="tag err">FAILED</span>'}${d.error ? `<div class="muted-sm">${esc(d.error)}</div>` : ""}</td>
          <td>${d.chunks}</td>
          <td class="muted-sm">${esc(d.created_at.slice(0, 10))}</td>
          <td class="right">
            <button class="btn small ghost" data-view-doc data-name="${esc(d.name)}" data-content="${esc(d.content)}">Voir</button>
            <button class="btn small ghost" data-reindex="${d.id}">Réindexer</button>
            <button class="btn small danger" data-confirm="Supprimer ce document et ses chunks ?" data-fetch-action="/api/knowledge/documents/${d.id}" data-method="DELETE">Suppr.</button>
          </td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<p class="muted" style="padding:14px 16px">Aucun document. Ajoutez votre première FAQ, politique de livraison, conditions commerciales…</p>'}
    </div>
  </div>
  <div id="docViewer" class="modal hidden"><div class="modal-box"><div class="card-head"><h3 id="docViewerName"></h3><button class="icon-btn" id="docViewerClose">✕</button></div><pre id="docViewerContent" class="doc-content"></pre></div></div>
  `);
}

/* ================= CONVERSATIONS ================= */
export function conversationsPage(ctx, { conversations }) {
  return layout(ctx, "Conversations IA", `
  <div class="page-toolbar"><h2>Conversations IA</h2><span class="muted-sm">Canal WEBSITE_TEST — ${conversations.length} conversation(s)</span></div>
  ${conversations.length ? `<div class="card table-card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Conversation</th><th>Lead</th><th>Statut</th><th>Messages</th><th>Mise à jour</th><th class="right"></th></tr></thead>
    <tbody>${conversations.map((c) => `<tr>
      <td class="strong">#${c.id.slice(0, 8)}</td>
      <td>${c.lead_name ? `<a class="row-link" href="/dashboard/leads">${esc(c.lead_name)}</a>` : "—"}</td>
      <td>${c.status === "HANDOFF" ? '<span class="tag warn">Handoff humain</span>' : c.status === "RESOLVED" ? '<span class="tag ok">Résolue</span>' : '<span class="tag ok">Active</span>'}</td>
      <td>${c.message_count}</td>
      <td class="muted-sm">${esc(new Date(c.updated_at).toLocaleString("fr-FR"))}</td>
      <td class="right"><a class="btn small ghost" href="/dashboard/conversations/${c.id}">Ouvrir</a></td>
    </tr>`).join("")}</tbody>
  </table></div></div>` : '<div class="card empty-state"><span class="empty-ico">💬</span><h3>Aucune conversation pour le moment.</h3><div class="empty-actions"><a class="btn primary" href="/dashboard/agent/playground">Tester l\'agent</a></div></div>'}
  `);
}

export function conversationDetailPage(ctx, { conversation: c, messages }) {
  const meta = safeMeta(c.metadata);
  return layout(ctx, `Conversation #${c.id.slice(0, 8)}`, `
  <div class="page-toolbar">
    <div>
      <h2>Conversation #${c.id.slice(0, 8)} ${c.status === "HANDOFF" ? '<span class="tag warn">Handoff</span>' : ""}</h2>
      <p class="muted">Canal ${esc(c.channel)} · ${esc(new Date(c.created_at).toLocaleString("fr-FR"))} · Lead : ${c.lead_id ? `<a href="/dashboard/leads">${esc(meta?.lead || "…")}</a>` : "—"}</p>
    </div>
    <div class="toolbar-actions">
      <button class="btn ghost" data-summary-conversation="${c.id}">📝 Résumer la conversation</button>
      <a class="btn ghost" href="/dashboard/conversations">← Retour</a>
    </div>
  </div>
  <div id="convSummary" class="conv-summary"></div>
  <div class="card conv-messages">
    ${messages.map((m) => {
      const mm = safeMeta(m.metadata);
      return m.role === "USER"
        ? `<div class="conv-msg user"><div class="bubble">${esc(m.content)}</div><span class="conv-time muted-sm">${esc(new Date(m.created_at).toLocaleTimeString("fr-FR"))}</span></div>`
        : `<div class="conv-msg agent">
            <div class="bubble">${esc(m.content)}</div>
            ${mm ? `<div class="conv-ai muted-sm">intent : <b>${esc(mm.intent || "—")}</b> · confiance : ${esc(mm.confidence || "—")} · score lead : ${mm.lead_score ?? "—"}${mm.tools?.length ? ` · outils : ${mm.tools.map(esc).join(", ")}` : ""}${mm.products?.length ? ` · produits : ${mm.products.map(esc).join(", ")}` : ""}${mm.actions?.length ? ` · actions : ${mm.actions.map(esc).join(", ")}` : ""}</div>` : ""}
            ${mm?.sources?.length ? `<div class="conv-sources muted-sm">Sources : ${mm.sources.map((s) => `${esc(s.document)} (score ${s.relevance_score})`).join(" · ")}</div>` : ""}
            <span class="conv-time muted-sm">${esc(new Date(m.created_at).toLocaleTimeString("fr-FR"))}</span>
          </div>`;
    }).join("")}
  </div>
  `);
}

function safeMeta(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
