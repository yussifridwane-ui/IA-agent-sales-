// server/channels/email.js — Phase 6 : client e-mail SMTP (Node natif, zéro dépendance)
// EHLO → [STARTTLS] → AUTH LOGIN → MAIL/RCPT/DATA → QUIT.
// Jamais de faux succès : seul le 250 final de DATA compte comme envoi réussi.
import { smtpSend, isTestEnv } from "./transport.js";
import { isValidEmail } from "../security.js";

/** Envoie un e-mail. config: { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_email, from_name }
 *  Threading (spec Phase 6 « Email threading ») : in_reply_to + references
 *  (en-têtes In-Reply-To / References) rattachent la réponse au thread d'origine. */
export async function sendEmail(config, { to, subject, text, in_reply_to = null, references = null }) {
  if (!to || !isValidEmail(to)) return { status: "failed", provider_message_id: null, error: "Adresse e-mail invalide." };
  const from = config.from_email || config.smtp_user;
  if (!from || !isValidEmail(from)) return { status: "failed", provider_message_id: null, error: "Adresse expéditeur (from_email) non configurée." };
  if (!config.smtp_host) return { status: "failed", provider_message_id: null, error: "Canal non configuré." };
  const r = await smtpSend({
    host: config.smtp_host,
    port: Number(config.smtp_port) || (config.smtp_secure ? 465 : 587),
    secure: !!config.smtp_secure,
    user: config.smtp_user || null,
    pass: config.smtp_pass || null,
    from,
    to,
    subject: String(subject || "(sans objet)"),
    text: String(text || "").slice(0, 20000),
    inReplyTo: in_reply_to || null,
    references: references || null,
  });
  return r.ok
    ? { status: "sent", provider_message_id: r.message_id, error: null }
    : { status: "failed", provider_message_id: null, error: r.error || "Échec SMTP" };
}

export async function verifyEmail(config) {
  if (!config?.smtp_host) return { ok: false, error: "Configuration incomplète (smtp_host)." };
  const r = await smtpSend({
    host: config.smtp_host, port: Number(config.smtp_port) || 587, secure: !!config.smtp_secure,
    user: config.smtp_user || null, pass: config.smtp_pass || null,
    from: config.from_email || config.smtp_user || "test@sales-agent.local",
    to: "verify@sales-agent.local", subject: "[test] vérification", text: "Vérification de la connexion SMTP.",
  }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  // En environnement test, la vérification passe par le mock (aucun réseau réel)
  if (!isTestEnv() && !r.ok) return { ok: false, error: r.error };
  return { ok: r.ok, error: r.ok ? null : r.error };
}
