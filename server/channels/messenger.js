// server/channels/messenger.js — Phase 6 : client Messenger (Page API Meta)
import { httpJson } from "./transport.js";

const API = "https://graph.facebook.com/v19.0";

/** Envoie un message texte Messenger à un PSID. config: { page_id, access_token } */
export async function sendMessenger(config, { to, text }) {
  if (!to || String(to).trim().length < 2) return { status: "failed", provider_message_id: null, error: "Identifiant Messenger (PSID) manquant." };
  const body = {
    recipient: { id: String(to) },
    message: { text: String(text || "").slice(0, 4000) },
  };
  const r = await httpJson("POST", `${API}/me/messages`, { token: config.access_token, body });
  if (!r.ok) return { status: "failed", provider_message_id: null, error: r.error || "Échec Messenger" };
  return { status: "sent", provider_message_id: r.data?.message_id || null, error: null };
}

export async function verifyMessenger(config) {
  if (!config?.access_token) return { ok: false, error: "Configuration incomplète (access_token)." };
  const r = await httpJson("GET", `${API}/me`, { token: config.access_token });
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error || "Vérification impossible" };
}
