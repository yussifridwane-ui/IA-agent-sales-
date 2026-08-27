// server/channels/instagram.js — Phase 6 : client Instagram Direct (Meta)
import { httpJson } from "./transport.js";

const API = "https://graph.facebook.com/v19.0";

/** Envoie un DM texte Instagram à un UID. config: { ig_user_id, access_token } */
export async function sendInstagram(config, { to, text }) {
  if (!to || String(to).trim().length < 2) return { status: "failed", provider_message_id: null, error: "Identifiant Instagram manquant." };
  const body = {
    message_format: "TEXT",
    recipient: { type: "USER", id: String(to) },
    text: String(text || "").slice(0, 4000),
  };
  const r = await httpJson("POST", `${API}/me/messages`, { token: config.access_token, body });
  if (!r.ok) return { status: "failed", provider_message_id: null, error: r.error || "Échec Instagram" };
  return { status: "sent", provider_message_id: r.data?.id || null, error: null };
}

export async function verifyInstagram(config) {
  if (!config?.access_token) return { ok: false, error: "Configuration incomplète (access_token)." };
  const r = await httpJson("GET", `${API}/me`, { token: config.access_token });
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error || "Vérification impossible" };
}
