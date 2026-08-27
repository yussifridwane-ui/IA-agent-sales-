// agent/engine.test.js — tests du moteur conversationnel (node:test)
import test from "node:test";
import assert from "node:assert/strict";
import { createAgent, detectIntent, extractEmail, extractName, extractPhone } from "./engine.js";

test("détecte les intentions de base", () => {
  assert.equal(detectIntent("Combien ça coûte ?"), "pricing");
  assert.equal(detectIntent("Quels sont vos tarifs ?"), "pricing");
  assert.equal(detectIntent("Quelles fonctionnalités ?"), "feature");
  assert.equal(detectIntent("Je veux une démo"), "demo");
  assert.equal(detectIntent("Bonjour !"), "greeting");
  assert.equal(detectIntent("On a beaucoup de leads qui se perdent"), "needs");
});

test("détecte les objections", () => {
  assert.equal(detectIntent("C'est trop cher pour nous"), "objection_price");
  assert.equal(detectIntent("On a déjà un autre CRM"), "objection_existing");
  assert.equal(detectIntent("Je n'ai pas le temps, plus tard"), "objection_time");
});

test("extrait les coordonnées", () => {
  assert.equal(extractEmail("mon e-mail est marie@exemple.fr, d'accord ?"), "marie@exemple.fr");
  assert.equal(extractPhone("mon téléphone est 06 12 34 56 78"), "0612345678");
  assert.equal(extractName("Je m'appelle Marie Dupont, ravi !"), "Marie Dupont");
});

test("parcours de vente complet jusqu'au lead (démo)", () => {
  const a = createAgent();
  const r1 = a.handle("bonjour");
  assert.equal(r1.state, "DISCOVERY");
  const r2 = a.handle("Je veux une démo");
  assert.equal(r2.state, "QUALIFICATION");
  assert.equal(r2.showLeadForm, true);
  const r3 = a.handle("Je m'appelle Marie Dupont, mon e-mail est marie@exemple.fr");
  assert.equal(r3.state, "CLOSED");
  const lead = a.getLead();
  assert.equal(lead.email, "marie@exemple.fr");
  assert.match(lead.name, /Marie Dupont/);
});

test("objection prix puis capture du lead", () => {
  const a = createAgent();
  a.handle("bonjour");
  const r = a.handle("c'est trop cher");
  assert.equal(r.state, "QUALIFICATION");
  assert.equal(r.showLeadForm, true);
  const r2 = a.handle("marie@exemple.fr");
  assert.equal(r2.state, "QUALIFICATION"); // demande le nom
  const r3 = a.handle("je m'appelle Marie");
  assert.equal(r3.state, "CLOSED");
  assert.equal(a.getLead().email, "marie@exemple.fr");
});

test("confirmation « oui » enchaîne sur l'action en attente", () => {
  const a = createAgent();
  a.handle("bonjour");
  a.handle("quels sont les tarifs ?");
  const r = a.handle("oui");
  assert.equal(r.state, "QUALIFICATION");
  assert.equal(r.showLeadForm, true);
});

test("refus de démo (chip « Non, je ne veux pas de démo ») est géré poliment", () => {
  assert.equal(detectIntent("Non, je ne veux pas de démo"), "confirm_no");
  const a = createAgent();
  a.handle("bonjour");
  a.handle("quelles fonctionnalités ?");
  a.handle("1 à 5");
  const r = a.handle("Non, je ne veux pas de démo");
  assert.match(r.reply, /D'accord/);
  assert.equal(r.showLeadForm, false);
  // L'agent peut alors rebondir sur un autre sujet
  const r2 = a.handle("quels sont les tarifs ?");
  assert.match(r2.reply, /Starter/);
});
