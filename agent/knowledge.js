// agent/knowledge.js
// Base de connaissances de l'agent : société, produits, tarifs, chiffres clés.
// Personnalisez ce fichier pour adapter l'agent à votre offre.

export const COMPANY = {
  name: "NovaTech",
  agentName: "Aria",
  product: "FlowCRM",
  tagline: "Le CRM tout-en-un des équipes commerciales",
  trial: "14 jours d'essai gratuit, sans carte bancaire",
};

export const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: "49 € / utilisateur / mois",
    features: [
      "Pipeline de vente visuel",
      "Gestion des contacts & tâches",
      "Modèles d'e-mails",
      "Support par e-mail",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "99 € / utilisateur / mois",
    features: [
      "Tout Starter",
      "Automatisations illimitées",
      "Scoring de leads par IA",
      "Intégrations : Slack, Gmail, HubSpot",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Sur devis",
    features: [
      "Tout Pro",
      "SSO & audit de sécurité",
      "API dédiée + exports",
      "Account manager dédié",
    ],
  },
];

export const STATS = [
  "−30 % de temps de saisie administrative dès le 1er mois",
  "+22 % de taux de closing après 3 mois d'utilisation",
  "2 400 équipes commerciales nous font confiance",
];
