// server/channels/whatsapp.js — Phase 6 : client WhatsApp Cloud API (Meta)
// Endpoints officiels graph.facebook.com — texte uniquement (Phase 6).
// Jamais de confirmation inventée : succès = 200 du Cloud API (livraison
// confirmée ensuite par webhook).

import { httpJson } from "./transport.js";

const API = "https://graph.facebook.com/v19.0";

/** Envoie un message texte WhatsApp. config: { phone_number_id, access_token } */
export async function sendWhatsApp(config, { to, text }) {
  const phone = String(to || "").replace(/[^\d]/g, "");
  if (phone.length < 8) return { status: "failed", provider_message_id: null, error: "Numéro WhatsApp invalide." };
  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { preview_url: false, body: String(text || "").slice(0, 4000) },
  };
  const r = await httpJson("POST", `${API}/${config.phone_number_id}/messages`, { token: config.access_token, body });
  if (!r.ok) return { status: "failed", provider_message_id: null, error: r.error || "Échec WhatsApp" };
  const id = r.data?.messages?.[0]?.id || null;
  return { status: "sent", provider_message_id: id, error: null };
}

/** Envoie un message WhatsApp depuis un TEMPLATE approuvé (Meta Cloud API).
 *  templates : { name, language, components: [{ type: "header"|"body"|"button", parameters: [] }] }
 *  config: { phone_number_id, access_token, template_name, template_language } */
export async function sendWhatsAppTemplate(config, { to, template_name, language, components = [] }) {
  const phone = String(to || "").replace(/[^\d]/g, "");
  if (phone.length < 8) return { status: "failed", provider_message_id: null, error: "Numéro WhatsApp invalide." };
  if (!config?.template_name) return { status: "failed", provider_message_id: null, error: "Template WhatsApp non approuvé (template_name requis)." };
  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: String(config.template_name),
      language: { code: config.template_language || "en_US" },
      components: components.map((c) => ({ type: c.type || "body", parameters: (c.parameters || []).map((p) => ({ type: "text", text: String(p) })) })),
    },
  };
  const r = await httpJson("POST", `${API}/${config.phone_number_id}/messages`, { token: config.access_token, body });
  if (!r.ok) return { status: "failed", provider_message_id: null, error: r.error || "Échec WhatsApp (template)." };
  const id = r.data?.messages?.[0]?.id || null;
  return { status: "sent", provider_message_id: id, error: null };
}

/** Liste les templates WhatsApp approuvés (GET /{phone_number_id}/message_templates). */
export async function listWhatsAppTemplates(config) {
  const phone = String(config?.phone_number_id || "").replace(/[^\d]/g, "");
  if (phone.length < 8 || !config?.access_token) return { status: "failed", templates: [], error: "Configuration incomplète." };
  const r = await httpJson("GET", `${API}/${phone}/message_templates`, { token: config.access_token });
  if (!r.ok) return { status: "failed", templates: [], error: r.error || "Échec liste templates." };
  return { status: "ok", templates: (r.data?.data || []).map((t) => ({ name: t.name, language: t.language, category: t.category, status: t.status })) };
}

/** Vérifie la connexion (GET sur le phone number). Renvoie { ok, error } */
export async function verifyWhatsApp(config) {
  if (!config?.phone_number_id || !config?.access_token) return { ok: false, error: "Configuration incomplète (phone_number_id + access_token)." };
  const r = await httpJson("GET", `${API}/${config.phone_number_id}`, { token: config.access_token });
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error || "Vérification impossible" };
}
