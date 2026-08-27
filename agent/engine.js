// agent/engine.js
// Moteur conversationnel de l'agent de vente :
// machine à états + détection d'intentions par mots-clés pondérés.
// Sans dépendance externe (aucun modèle externe requis, 100 % hors-ligne).
import { COMPANY, PLANS, STATS } from "./knowledge.js";

const AGENT = COMPANY.agentName;
const PRODUCT = COMPANY.product;

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/['’ʼ]/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// L'ordre des intentions définit la priorité en cas d'égalité de score.
const INTENTS = {
  decline: [
    "pas interesse",
    "ne m'interesse",
    "aucun interet",
    "lacher",
    "stop",
    "arreter",
    "je suis pas partant",
  ],
  objection_time: [
    "pas le temps",
    "pas maintenant",
    "plus tard",
    "je reflechis",
    "je veux reflechir",
    "je vais reflechir",
    "en reflexion",
    "j'hesite",
    "hesite",
    "semaine prochaine",
    "le mois prochain",
    "bientot",
  ],
  objection_existing: [
    "deja un",
    "deja une",
    "on utilise",
    "j'utilise",
    "notre crm",
    "on a deja",
    "j'ai deja",
    "autre outil",
    "autre crm",
    "autre solution",
    "outillage",
  ],
  objection_price: [
    "trop cher",
    "cher",
    "pas de budget",
    "pas le budget",
    "pas les moyens",
    "reduction",
    "promo",
    "remise",
    "negocier",
    "renegocier",
    "investissement",
  ],
  human: [
    "humain",
    "humaine",
    "commercial",
    "votre equipe",
    "quelqu'un",
    "vraie personne",
    "agent reel",
    "parler a",
    "telephone",
  ],
  demo: [
    "demo",
    "demonstration",
    "essayer",
    "essai",
    "tester",
    "test",
    "commencer",
    "rendez-vous",
    "rdv",
    "m'ecrire",
    "m'envoyer",
    "inscription",
    "s'inscrire",
    "creer un compte",
    "essai gratuit",
    "visio",
    "appel",
  ],
  team: [
    "1 a 5",
    "2 a 10",
    "6 a 20",
    "plus de 20",
    "moins de 5",
    "moins de 10",
    "une dizaine",
    "quinze personnes",
  ],
  identity: [
    "qui es-tu",
    "qu'es-tu",
    "ton nom",
    "quel est ton nom",
    "qui etes-vous",
    "votre nom",
    "qu'est-ce que tu fais",
  ],
  pricing: [
    "tarif",
    "tarifs",
    "prix",
    "combien",
    "coute",
    "cout",
    "abonnement",
    "mensualite",
    "gratuit",
    "gratuite",
    "payant",
    "payante",
    "devis",
  ],
  feature: [
    "fonction",
    "fonctionnalite",
    "que fait",
    "que propose",
    "capacite",
    "modul",
    "automatis",
    "scoring",
    "rapport",
    "dashboard",
    "tableau de bord",
    "integrat",
    "inclus",
    "contenu",
  ],
  needs: [
    "lead",
    "leads",
    "prospect",
    "prospecter",
    "suivi",
    "pipeline",
    "relance",
    "relancer",
    "perdu",
    "perdre",
    "doublon",
    "client",
    "clients",
    "vente",
    "vendre",
    "vends",
    "equipe",
    "retard",
    "opportunite",
  ],
  greeting: ["bonjour", "bonsoir", "salut", "hello", "coucou", "salutations", "hey"],
  thanks: ["merci", "genial", "super", "parfait", "excellent", "top"],
  goodbye: ["au revoir", "aurevoir", "bye", "a plus", "adieu", "bonne journee", "bonne soiree", "j'y vais", "je retourne"],
  confirm_yes: [
    "oui",
    "ok",
    "okay",
    "d'accord",
    "d'acord",
    "pourquoi pas",
    "partant",
    "volontiers",
    "ca m'interesse",
    "m'interesse",
    "faisons",
  ],
  confirm_no: ["non", "non merci", "je ne veux pas", "pas besoin", "abandonnons"],
};

const tokenize = (s) => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);

// Vrai sous-ensemble de tokens consécutifs (pour les expressions multi-mots).
function hasSubsequence(tokens, parts) {
  outer: for (let i = 0; i + parts.length <= tokens.length; i++) {
    for (let j = 0; j < parts.length; j++) {
      if (tokens[i + j] !== parts[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function detectIntent(text) {
  const tokens = tokenize(text);
  let best = "unknown";
  let bestScore = 0;
  for (const [intent, patterns] of Object.entries(INTENTS)) {
    let score = 0;
    for (const p of patterns) {
      const pat = normalize(p);
      if (pat.includes(" ")) {
        // Expression multi-mots : séquence de tokens consécutifs
        if (hasSubsequence(tokens, tokenize(pat))) score += 2;
      } else {
        // Mot simple : égalité exacte, ou préfixe si la racine est assez
        // longue pour éviter les faux positifs (gère les pluriels :
        // "fonction" → "fonctionnalités", "automatis" → "automatisations"…).
        if (tokens.some((t) => t === pat || (pat.length >= 5 && t.startsWith(pat)))) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

export function extractEmail(text) {
  const m = String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

export function extractPhone(text) {
  const digits = String(text).replace(/[^\d+]/g, "").replace(/^\+/, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

const NAME_RE = /(?:je m'appele|je m'appelle|mon nom est|mon nom c'est|s'appelle)\s+([a-zà-ÿa-z]+(?:[\s'-][a-zà-ÿa-z]+){0,2})/i;

export function extractName(text) {
  const t = String(text).replace(/['’ʼ]/g, "'");
  const m = t.match(NAME_RE);
  if (!m) return null;
  const name = m[1].replace(/[,.!?;:]+$/, "").trim();
  if (!name) return null;
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export const STATE_LABELS = {
  START: "Prise de contact",
  DISCOVERY: "Découverte",
  PRESENTATION: "Présentation produit",
  OBJECTION: "Traitement d'objection",
  QUALIFICATION: "Qualification",
  CLOSED: "Lead capturé 🎯",
};

const NEED_BENEFITS = [
  { re: /lead|prospect/, b: "Grâce au scoring de leads par IA, vos commerciaux traitent d'abord les bonnes opportunités" },
  { re: /relance|perdu|perdre|retard/, b: "Grâce aux relances automatisées, plus aucune opportunité n'est abandonnée" },
  { re: /suivi|pipeline|opportunite|vente/, b: "Grâce au pipeline visuel et aux prévisions, tout le monde sait où en est chaque deal" },
  { re: /client|contact|doublon|equipe/, b: "Grâce au suivi centralisé, toute l'équipe partage la même vision des clients" },
];

const FALLBACKS = [
  "Je ne suis pas sûr d'avoir bien compris 😅 Le plus utile pour moi : les tarifs, les fonctionnalités, ou une démo. Qu'est-ce qui vous aiderait le plus ?",
  "Bonne question ! Pour vous répondre au mieux, orientez-moi : tarifs, fonctionnalités, démo, ou un cas d'usage précis ?",
];

export function createAgent() {
  let state = "START"; // START | DISCOVERY | PRESENTATION | OBJECTION | QUALIFICATION | CLOSED
  let lead = null; // { name, email, phone }
  let messageCount = 0;
  let pendingAction = null; // "demo" | "callback"
  let qualifyMode = "demo"; // "demo" | "callback"
  let lastUnknown = 0;

  /* ---------- Réponses ---------- */

  const intro = () => ({
    reply:
      `Bonjour ! 👋 Je suis ${AGENT}, l'agent de vente IA de ${COMPANY.name}.\n\n` +
      `Je peux vous parler de ${PRODUCT} (${COMPANY.tagline.toLowerCase()}), comparer les formules, répondre à vos objections — et vous organiser une démo de 15 minutes.\n\n` +
      `Parlez-moi vite de votre activité : quel est votre plus gros défi commercial aujourd'hui ?`,
    quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
    showLeadForm: false,
  });

  const pricing = () => ({
    reply:
      `Voici les formules ${PRODUCT} :\n\n` +
      PLANS.map((p) => `• ${p.name} — ${p.price} : ${p.features.slice(1, 4).join(", ").toLowerCase()}`).join("\n") +
      `\n\nEt ${COMPANY.trial.toLowerCase()}, sans engagement.\n\n` +
      `À noter : ~70 % des équipes choisissent le plan Pro — les automatisations et le scoring de leads font la vraie différence.\n\n` +
      `Voulez-vous que je vous prépare une démo personnalisée ?`,
    quickReplies: ["Oui, je veux une démo", "C'est trop cher", "On a déjà un autre CRM", "Merci, je vais réfléchir"],
    showLeadForm: false,
  });

  const features = () => ({
    reply:
      `${PRODUCT} centralise toute votre activité commerciale :\n\n` +
      `• Pipeline de vente visuel avec prévision de closing\n` +
      `• Suivi des contacts, tâches et relances automatiques\n` +
      `• Automatisations prêtes à l'emploi (e-mails, notifications, attribution de leads)\n` +
      `• Scoring de leads par IA pour prioriser les bonnes opportunités\n` +
      `• Tableaux de bord & rapports en temps réel\n` +
      `• Intégrations : Gmail, Slack, HubSpot, Zapier\n\n` +
      `Pour bien caler la démo : combien de personnes dans votre équipe commerciale ?`,
    quickReplies: ["1 à 5", "6 à 20", "Plus de 20", "Je veux une démo"],
    showLeadForm: false,
  });

  const team = () => ({
    reply:
      `Parfait 👍 Pour une équipe de cette taille, le plan Pro est généralement le meilleur rapport qualité/prix : automatisations + scoring de leads inclus.\n\n` +
      `Voulez-vous que je vous organise une démo de 15 minutes ?`,
    quickReplies: ["Oui, je veux une démo", "Non, je ne veux pas de démo", "Quels sont les tarifs ?"],
    showLeadForm: false,
  });

  const needs = (text) => {
    const b = NEED_BENEFITS.find((x) => x.re.test(text))?.b ?? "Grâce à une automatisation complète de votre suivi commercial";
    return {
      reply:
        `Bonne nouvelle : c'est exactement le type de problème que ${PRODUCT} résout.\n\n` +
        `${b}.\n` +
        `Résultats constatés chez nos clients : ${STATS[0].toLowerCase()} dès le premier mois, et ${STATS[1].toLowerCase()} après 3 mois.\n\n` +
        `Voulez-vous voir une démo de 15 minutes ? C'est gratuit, sans carte bancaire.`,
      quickReplies: ["Oui, une démo", "Quels sont les tarifs ?", "On a déjà un autre CRM"],
      showLeadForm: false,
    };
  };

  const objectionPrice = () => ({
    reply:
      `Je comprends, le budget est un vrai sujet. Quelques chiffres pour contextualiser :\n\n` +
      `• ${STATS[0]}\n• ${STATS[1]}\n\n` +
      `Autrement dit, ${PRODUCT} se rembourse sur un seul deal récupéré par mois. Et vous pouvez commencer sur Starter (${PLANS[0].price}) pour tester sans risque — l'essai de 14 jours est gratuit, sans carte bancaire.\n\n` +
      `Je peux aussi vous envoyer un calcul de ROI personnalisé : laissez-moi juste votre e-mail 📩`,
    quickReplies: [],
    showLeadForm: true,
  });

  const objectionExisting = () => ({
    reply:
      `Pas de souci — la plupart de nos clients arrivaient d'un autre CRM (HubSpot, Pipedrive… ou Excel 😄).\n\n` +
      `Ce qui change vraiment avec ${PRODUCT} :\n` +
      `• Le scoring de leads par IA\n` +
      `• Les automatisations prêtes en 5 minutes\n` +
      `• Une prise en main en 1 journée (on gère la migration pour vous)\n\n` +
      `On peut aussi tester en parallèle 2 semaines, sans toucher à votre outil actuel. Une démo comparative vous intéresse ?`,
    quickReplies: ["Oui, montre-moi", "C'est trop cher", "Je veux réfléchir"],
    showLeadForm: false,
  });

  const objectionTime = () => ({
    reply:
      `Pas de panique, rien à installer, rien à lire ce soir 😄\n\n` +
      `Le plus simple : je vous envoie un résumé de 1 page (fonctions clés, tarifs, ROI) par e-mail, et vous le lisez quand vous voulez.\n\n` +
      `Quel est le meilleur e-mail pour vous joindre ?`,
    quickReplies: [],
    showLeadForm: true,
  });

  const demoAsk = () => ({
    reply:
      `Avec plaisir ! 🚀\n\n` +
      `Pour préparer une démo qui vous ressemble (15 min, gratuite, en visio), il me faut juste :\n` +
      `• votre nom\n` +
      `• votre e-mail professionnel\n\n` +
      `Un membre de l'équipe ${COMPANY.name} (ou moi-même 😉) vous contactera sous 24 h pour bloquer un créneau.`,
    quickReplies: [],
    showLeadForm: true,
  });

  const demoConfirmed = () => ({
    reply:
      `Parfait${lead.name ? `, ${lead.name}` : ""} ! 🎯\n\n` +
      `Votre demande de démo est enregistrée (e-mail : ${lead.email}${lead.phone ? `, tél. : ${lead.phone}` : ""}).\n` +
      `Un membre de l'équipe ${COMPANY.name} vous recontacte sous 24 h ouvrées pour planifier 15 minutes en visio.\n\n` +
      `Vous recevrez aussi un e-mail de confirmation avec le sommaire. Merci pour votre confiance ! 🚀`,
    quickReplies: ["Merci !", "Quels sont les tarifs ?", "Au revoir"],
    showLeadForm: false,
  });

  const callbackAsk = () => ({
    reply:
      `Bien sûr, je peux transmettre votre demande à un commercial de l'équipe ${COMPANY.name} 📞\n\n` +
      `Pour qu'il puisse vous joindre au bon moment, laissez-moi votre nom, votre e-mail (et un numéro de téléphone si vous préférez).`,
    quickReplies: [],
    showLeadForm: true,
  });

  const callbackSent = () => ({
    reply:
      `Parfait${lead.name ? `, ${lead.name}` : ""} ! 📩\n\n` +
      `Le résumé ${PRODUCT} (fonctions clés, tarifs, calcul de ROI) part vers ${lead.email}.\n\n` +
      `Vous le lisez à votre rythme, sans engagement. Une question entre-temps ? Je suis là !`,
    quickReplies: ["Merci !", "Au revoir"],
    showLeadForm: false,
  });

  const identity = () => ({
    reply:
      `Je suis ${AGENT} 🤖, l'agent de vente IA de ${COMPANY.name}.\n\n` +
      `Je connais ${PRODUCT} sur le bout des doigts : fonctionnalités, tarifs, cas d'usage, objections courantes. Mon but : vous aider à savoir si ${PRODUCT} mérite 15 minutes de votre temps — sans vous faire perdre l'autre.\n\n` +
      `Que voulez-vous savoir en premier ?`,
    quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
    showLeadForm: false,
  });

  const thanks = () => ({
    reply: `Avec plaisir ! 💪 N'hésitez pas si une autre question vous vient — je ne dors jamais.`,
    quickReplies: ["Oui, je veux une démo", "Non, merci"],
    showLeadForm: false,
  });

  const goodbye = () => ({
    reply: `Merci pour votre passage ! 👋 Si vous voulez revenir sur ${PRODUCT}, je suis là 24 h/24. Bonne journée !`,
    quickReplies: [],
    showLeadForm: false,
  });

  const decline = () => ({
    reply: `Pas de souci, je respecte votre choix. Si un jour votre pipeline a besoin d'un coup de boost, vous savez où me trouver. Bonne route ! 🚀`,
    quickReplies: [],
    showLeadForm: false,
  });

  const confirmNo = () => ({
    reply: `D'accord, on garde ça pour plus tard 🙌 Autre chose que je peux faire pour vous ?`,
    quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
    showLeadForm: false,
  });

  const fallback = () => ({
    reply: FALLBACKS[lastUnknown % FALLBACKS.length],
    quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
    showLeadForm: false,
  });

  /* ---------- Transitions ---------- */

  function demoFlow() {
    if (lead?.email) {
      state = "CLOSED";
      pendingAction = null;
      return demoConfirmed();
    }
    state = "QUALIFICATION";
    qualifyMode = "demo";
    pendingAction = "demo";
    return demoAsk();
  }

  function resolvePending() {
    if (pendingAction === "demo") return demoFlow();
    if (pendingAction === "callback") {
      if (lead?.email) {
        state = "CLOSED";
        pendingAction = null;
        return callbackSent();
      }
      state = "QUALIFICATION";
      qualifyMode = "callback";
      return callbackAsk();
    }
    pendingAction = null;
    return {
      reply: `Parfait ! Que voulez-vous faire : une démo, voir les tarifs, ou connaître les fonctionnalités ?`,
      quickReplies: ["Je veux une démo", "Quels sont les tarifs ?", "Quelles fonctionnalités ?"],
      showLeadForm: false,
    };
  }

  function normalFlow(intent, text) {
    switch (intent) {
      case "greeting":
        if (state === "START" || messageCount <= 2) {
          state = "DISCOVERY";
          return intro();
        }
        state = "DISCOVERY";
        return {
          reply: `Bonjour ! 👋 Comment puis-je vous aider ?`,
          quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
          showLeadForm: false,
        };
      case "pricing":
        state = "PRESENTATION";
        pendingAction = "demo";
        return pricing();
      case "feature":
        state = "PRESENTATION";
        pendingAction = "demo";
        return features();
      case "team":
        state = "PRESENTATION";
        pendingAction = "demo";
        return team();
      case "needs":
        state = "PRESENTATION";
        pendingAction = "demo";
        return needs(text);
      case "objection_price":
        state = "QUALIFICATION";
        qualifyMode = "callback";
        pendingAction = "callback";
        return objectionPrice();
      case "objection_existing":
        state = "OBJECTION";
        pendingAction = "demo";
        return objectionExisting();
      case "objection_time":
        state = "QUALIFICATION";
        qualifyMode = "callback";
        pendingAction = "callback";
        return objectionTime();
      case "demo":
        return demoFlow();
      case "human":
        state = "QUALIFICATION";
        qualifyMode = "callback";
        pendingAction = "callback";
        return callbackAsk();
      case "identity":
        state = "DISCOVERY";
        return identity();
      case "thanks":
        return thanks();
      case "goodbye":
        return goodbye();
      case "decline":
        state = "DISCOVERY";
        return decline();
      case "confirm_yes":
        return resolvePending();
      case "confirm_no":
        pendingAction = null;
        return confirmNo();
      default:
        lastUnknown++;
        return fallback();
    }
  }

  function qualificationFlow(intent) {
    if (intent === "decline" || intent === "goodbye") {
      state = "DISCOVERY";
      pendingAction = null;
      return {
        reply: `Pas de souci, je vous laisse tranquille 🙌 Si vous changez d'avis, je suis là 24 h/24. Bonne journée !`,
        quickReplies: [],
        showLeadForm: false,
      };
    }
    if (lead?.email && lead?.name) {
      state = "CLOSED";
      pendingAction = null;
      return qualifyMode === "demo" ? demoConfirmed() : callbackSent();
    }
    if (lead?.email && !lead?.name) {
      return {
        reply: `E-mail noté ✅ Et votre prénom ou nom, pour que je personnalise la démo ?`,
        quickReplies: [],
        showLeadForm: true,
      };
    }
    if (lead?.name && !lead?.email) {
      return {
        reply: `Merci ${lead.name} ! Et votre adresse e-mail pour l'invitation ?`,
        quickReplies: [],
        showLeadForm: true,
      };
    }
    const nudge =
      intent === "unknown"
        ? `Pas de souci 🙂 Pour finaliser, il me manque juste votre nom et votre e-mail — vous pouvez aussi remplir le petit formulaire ci-dessous.`
        : `Bien noté 🙂 — et pour finaliser, votre nom et votre e-mail ? (ou le formulaire ci-dessous)`;
    return { reply: nudge, quickReplies: [], showLeadForm: true };
  }

  /* ---------- API publique ---------- */

  function handle(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      return {
        reply: "Je n'ai rien reçu — pouvez-vous réécrire votre message ? 🙏",
        quickReplies: [],
        showLeadForm: false,
        state,
        stateLabel: STATE_LABELS[state],
        leadCaptured: Boolean(lead?.email),
      };
    }
    messageCount++;
    const intent = detectIntent(text);
    const found = { email: extractEmail(text), phone: extractPhone(text), name: extractName(text) };
    if (found.name && !lead?.name) lead = { ...(lead || {}), name: found.name };
    if (found.phone && !lead?.phone) lead = { ...(lead || {}), phone: found.phone };
    if (found.email && !lead?.email) lead = { ...(lead || {}), email: found.email };

    const out = state === "QUALIFICATION" ? qualificationFlow(intent) : normalFlow(intent, text);
    return { ...out, state, stateLabel: STATE_LABELS[state], leadCaptured: Boolean(lead?.email) };
  }

  function attachLead(l = {}) {
    lead = {
      name: l.name || lead?.name || null,
      email: l.email || lead?.email || null,
      phone: l.phone || lead?.phone || null,
    };
  }

  function confirmLead() {
    state = "CLOSED";
    pendingAction = null;
    const out = qualifyMode === "demo" ? demoConfirmed() : callbackSent();
    return { ...out, state, stateLabel: STATE_LABELS[state], leadCaptured: Boolean(lead?.email) };
  }

  function reset() {
    state = "DISCOVERY";
    lead = null;
    messageCount = 0;
    pendingAction = null;
    qualifyMode = "demo";
    lastUnknown = 0;
    return {
      reply: `Conversation réinitialisée ✅ Bonjour ! 👋 Je suis ${AGENT}, l'agent de vente IA de ${COMPANY.name}. Par où souhaitez-vous commencer ?`,
      quickReplies: ["Quels sont les tarifs ?", "Quelles fonctionnalités ?", "Je veux une démo"],
      showLeadForm: false,
      state: "DISCOVERY",
      stateLabel: STATE_LABELS.DISCOVERY,
      leadCaptured: false,
    };
  }

  return {
    handle,
    reset,
    attachLead,
    confirmLead,
    getLead: () => ({ ...lead }),
    getState: () => state,
  };
}
