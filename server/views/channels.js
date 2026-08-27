// server/views/channels.js — Phase 6 : page /dashboard/channels
import { esc } from "../security.js";
import { appLayout } from "./app.js";

const STATUS_BADGES = {
  CONNECTED: ["#16a34a", "Connecté"],
  DISCONNECTED: ["#64748b", "Non connecté"],
  ERROR: ["#dc2626", "Erreur"],
};
const MSG_STATUS = { PENDING: "⏳", SENT: "📤", DELIVERED: "📬", READ: "👁", FAILED: "❌", BOUNCED: "↩️" };
const CHANNEL_FIELDS = {
  WHATSAPP: [
    ["phone_number_id", "Phone Number ID (WhatsApp Business)", "1234567890"],
    ["access_token", "Access Token (permanente)", "EAAG..."],
    ["verify_token", "Verify Token (webhook)", "mon-token-sec"],
  ],
  FACEBOOK_MESSENGER: [
    ["page_id", "Page ID (Facebook)", "1023456789"],
    ["access_token", "Access Token (page)", "EAAG..."],
    ["verify_token", "Verify Token (webhook)", "mon-token-sec"],
  ],
  INSTAGRAM: [
    ["ig_user_id", "IG User ID", "17841400000000000"],
    ["access_token", "Access Token", "EAAG..."],
    ["verify_token", "Verify Token (webhook)", "mon-token-sec"],
  ],
  EMAIL: [
    ["smtp_host", "Serveur SMTP", "smtp.example.com"],
    ["smtp_port", "Port", "587"],
    ["smtp_user", "Utilisateur", "vous@example.com"],
    ["smtp_pass", "Mot de passe applicatif", "••••••••"],
    ["from_email", "Adresse expéditeur", "no-reply@example.com"],
    ["from_name", "Nom expéditeur (optionnel)", "AI Sales Agent"],
  ],
};
const WEBHOOK_PATHS = {
  WHATSAPP: "/api/webhooks/whatsapp",
  FACEBOOK_MESSENGER: "/api/webhooks/facebook",
  INSTAGRAM: "/api/webhooks/instagram",
  EMAIL: null,
};

export function channelsPage({ user, org, role, path, csrf, connections, messages, CHANNELS, widgetKey, defaultMode, origin }) {
  const canManage = ["OWNER", "ADMIN", "MANAGER"].includes(role);
  const byChannel = Object.fromEntries(connections.map((c) => [c.channel, c]));
  const cards = CHANNELS.map((ch) => {
    const conn = byChannel[ch];
    const [color, label] = STATUS_BADGES[conn?.status || "DISCONNECTED"] || STATUS_BADGES.DISCONNECTED;
    const fields = (CHANNEL_FIELDS[ch] || []).map(([f, lab, ph]) => `
      <div class="field">
        <label>${esc(lab)}</label>
        <input type="${f === "smtp_pass" ? "password" : "text"}" name="${f}" value="${esc(conn?.config?.[f] || "")}" placeholder="${esc(ph || "")}" ${f === "smtp_pass" ? 'autocomplete="new-password"' : ""}/>
      </div>`).join("");
    const secure = ch === "EMAIL" ? `<div class="field"><label>SMTP sécurisé (TLS/465)</label><select name="smtp_secure"><option value="">Non (STARTTLS 587)</option><option value="true">Oui (TLS 465)</option></select></div>` : "";
    const webhook = WEBHOOK_PATHS[ch] ? `
      <div class="muted-sm" style="margin:8px 0 0">
        <b>Webhook à déclarer chez le fournisseur :</b> <code>${esc(WEBHOOK_PATHS[ch])}</code><br/>
        Secret de signature (X-Hub-Signature-256) : <code>${esc(conn?.has_webhook_secret ? "•••• (généré)" : "non généré")}</code>
      </div>` : "";
    return `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">${esc(conn?.label || ch)}</h3>
        <span class="badge-l" style="background:color-mix(in srgb, ${color} 14%, transparent); color:${color}">${label}</span>
        ${conn?.last_error ? `<span class="muted-sm" title="${esc(conn.last_error)}">⚠ ${esc(String(conn.last_error).slice(0, 60))}</span>` : ""}
      </div>
      ${conn?.last_checked_at ? `<p class="muted-sm">Dernière vérification : ${esc(conn.last_checked_at.slice(0, 16).replace("T", " "))}${conn.connected_at ? ` · connecté le ${esc(conn.connected_at.slice(0, 10))}` : ""}</p>` : ""}
      ${canManage ? `
      <form data-fetch method="POST" action="/api/channels/${ch}" data-method="PUT" data-stay="on">
        <input type="hidden" name="display_name" value="${esc(conn?.display_name || "")}"/>
        <div class="builder-row" style="flex-wrap:wrap">${fields}${secure}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button type="submit" class="btn primary">Connecter / Mettre à jour</button>
          ${conn?.status === "CONNECTED" ? `<button type="button" class="btn ghost" data-confirm="Déconnecter ce canal ?" data-fetch-action="/api/channels/${ch}" data-method="DELETE">Déconnecter</button>` : ""}
        </div>
      </form>` : `<p class="muted-sm">Connecté par l'administrateur. (rôle ${esc(role)} : lecture seule)</p>`}
      ${webhook}
    </div>`;
  }).join("");

  const msgRows = messages.slice(0, 50).map((m) => `
    <tr>
      <td class="muted-sm">${esc((m.created_at || "").slice(0, 16).replace("T", " "))}</td>
      <td>${esc(m.channel)}</td>
      <td>${m.direction === "IN" ? "⬇️ Reçu" : "⬆️ Envoyé"}</td>
      <td>${esc(m.lead_name || "—")}</td>
      <td class="muted-sm">${esc(m.direction === "IN" ? m.from_address || "" : m.to_address || "")}</td>
      <td>${esc(String(m.content || "").slice(0, 80))}</td>
      <td>${MSG_STATUS[m.status] || ""} ${esc(m.status)}${m.error ? `<div class="muted-sm">${esc(String(m.error).slice(0, 50))}</div>` : ""}</td>
    </tr>`).join("");

  return appLayout({
    title: "Canaux",
    user, org, role, path, csrf,
    content: `
    <section class="page-head">
      <div>
        <h2>Canaux de communication</h2>
        <p class="muted">Connexion aux API officielles (WhatsApp Cloud API, Messenger, Instagram Direct, SMTP).
        Les envois sont <b>réels</b> — sans fournisseur connecté, l'envoi échoue honnêtement (« Canal non configuré. »), jamais simulé.</p>
      </div>
    </section>
    ${cards}
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">💬 Webchat (widget intégré)</h3>
        <span class="badge-l" style="background:color-mix(in srgb, #16a34a 14%, transparent); color:#16a34a">Intégré — toujours disponible</span>
      </div>
      <p class="muted-sm" style="margin:8px 0 4px">
        Widget public à intégrer sur votre site. La <b>clé du widget est un identifiant public</b> (jamais un secret) :
        seule la conversation du visiteur est accessible, avec rate limiting. Les réponses respectent le <b>mode de traitement</b>
        (IA / Humain / Hybride) configuré dans <em>Agent → Réglages</em> (mode actuel par défaut : <b>${esc(defaultMode || "AI")}</b>).
      </p>
      <div class="field" style="margin-top:8px">
        <label>URL du widget (clé publique)</label>
        <input type="text" readonly value="/widget?k=${esc(widgetKey || "")}" onclick="this.select()" style="width:100%"/>
      </div>
      <details style="margin-top:8px">
        <summary class="muted-sm" style="cursor:pointer">Code d'intégration (iframe)</summary>
        <pre style="background:var(--soft,#f1f5f9);border-radius:8px;padding:10px;font-size:12px;overflow:auto;white-space:pre-wrap">&lt;iframe src="${esc(origin || "")}/widget?k=${esc(widgetKey || "")}" width="380" height="560" style="border:0;border-radius:14px" title="Chat"&gt;&lt;/iframe&gt;</pre>
      </details>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px">Boîte de réception (100 derniers messages)</h3>
      <table class="tbl">
        <thead><tr><th>Date</th><th>Canal</th><th>Sens</th><th>Lead</th><th>Adresse</th><th>Contenu</th><th>Statut</th></tr></thead>
        <tbody>${msgRows || `<tr><td colspan="7" class="muted">Aucun message échangé sur les canaux officiels pour l'instant.</td></tr>`}</tbody>
      </table>
    </div>`,
  });
}
