/**
 * YODA MAILER V5 — Backend avec obfuscation et templates dynamiques
 * Plateforme d'emailing : Resend (API HTTPS) + SMTP, avec gate d'accès par code.
 * Fonctions : envoi individuel (perso {{name}} + obfuscation), envoi groupé BCC, pièces jointes,
 * reply-to, cc, test de connexion, profils, envoi en arrière-plan (pause/reprise/stop).
 * Templates HTML dynamiques avec logo, couleurs personnalisées et reformulation.
 * Sauvegarde et chargement de configuration (export/import JSON).
 */

const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
// Limite élevée pour accepter les pièces jointes encodées en base64 dans le JSON
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────
const ACCESS_CODE = process.env.ACCESS_CODE || 'YODA-2025-CHANGE-MOI';
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 h
const BCC_CHUNK = 45;                     // < limite Resend (50 dest./envoi)
const RATE_MAX_PER_SEC = 10;              // plafond dur : 10 requêtes/seconde max
const RATE_MIN_INTERVAL = Math.ceil(1000 / RATE_MAX_PER_SEC); // 100 ms entre 2 départs
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Limiteur de débit : garantit au moins RATE_MIN_INTERVAL ms entre deux requêtes
let lastSendAt = 0;
async function rateGate() {
  const wait = RATE_MIN_INTERVAL - (Date.now() - lastSendAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();
}

if (ACCESS_CODE === 'YODA-2025-CHANGE-MOI') {
  console.warn('\n⚠  ACCESS_CODE par défaut détecté. Définis ACCESS_CODE dans .env / Render pour sécuriser.\n');
}

// ─────────────────────────────────────────────────────
// STOCKAGE EN MÉMOIRE (repart à zéro au redémarrage)
// ─────────────────────────────────────────────────────
let profiles = [];
let queue = emptyQueue();
let history = [];       // historique d'envoi { email, name, status, timestamp, account?, error?, provider? }
const HISTORY_MAX = 5000;  // limite raisonnable pour éviter d'exploser la RAM

function pushHistory(entry) {
  history.push({ ...entry, timestamp: new Date().toISOString() });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}
const sessions = new Map(); // token -> expiresAt

function emptyQueue() {
  return { status: 'idle', recipients: [], logs: [], sent: 0, failed: 0, total: 0 };
}

// ─────────────────────────────────────────────────────
// CHARGEMENT / SAUVEGARDE DE CONFIGURATION (fichier JSON)
// ─────────────────────────────────────────────────────
function loadConfigFromFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(data);
      return config;
    }
  } catch (err) {
    console.warn('⚠  Impossible de charger le fichier de configuration:', err.message);
  }
  return null;
}

function saveConfigToFile(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('❌ Erreur lors de la sauvegarde de la configuration:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────
// CONFIGURATION UTILISATEUR (logo, couleur, nom entreprise, URL CTA)
// ─────────────────────────────────────────────────────
let userConfig = {
  companyName: 'DEVICO',
  logoUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS7QVfumi8Vo4GBaNvwRVGWd1tKc4qS2uDu_AGGnF9A6A&s=10',
  primaryColor: '#003da5',
  buttonColor: '#003da5',
  ctaUrl: 'https://example.com',
  mentionsLegales: 'Société Anonyme à Directoire et Conseil de Surveillance – Capital social : 6 585 350 218 €\n115 rue de Sèvres, 75275 Paris CEDEX 06 – RCS Paris 421 100 645 – ORIAS n° 07 023 424'
};

// Charger la configuration depuis le fichier si existant
const savedConfig = loadConfigFromFile();
if (savedConfig) {
  userConfig.companyName = savedConfig.companyName || userConfig.companyName;
  userConfig.logoUrl = savedConfig.logoUrl || userConfig.logoUrl;
  userConfig.primaryColor = savedConfig.primaryColor || userConfig.primaryColor;
  userConfig.buttonColor = savedConfig.primaryColor || userConfig.buttonColor;
  userConfig.ctaUrl = savedConfig.ctaUrl || userConfig.ctaUrl;
  userConfig.mentionsLegales = savedConfig.mentionsLegales || userConfig.mentionsLegales;
}

// ─────────────────────────────────────────────────────
// SYSTÈME DE SYNONYMES (version enrichie avec plus de 500+ synonymes)
// ─────────────────────────────────────────────────────
// Base de synonymes robuste — chaque entrée est substituable dans un contexte
// administratif/technique (email de service, notification, procédure).
// Genre grammatical et nombre préservés. Pas de faux-amis contextuels.
// Objectif : ~8 synonymes par entrée quand la langue le permet honnêtement.

// Base de synonymes robuste — chaque entrée est substituable dans un contexte
// administratif/technique (email de service, notification, procédure).
// Genre grammatical et nombre préservés. Pas de faux-amis contextuels.
// Objectif : ~8 synonymes par entrée quand la langue le permet honnêtement.

const SYNONYMS = {

  // ═══════════════════════════════════════════════════════════════
  // VERBES
  // ═══════════════════════════════════════════════════════════════

  // --- Perception / constat ---
  'détecté': ['repéré', 'constaté', 'identifié', 'relevé', 'observé', 'décelé', 'remarqué', 'noté'],
  'détectons': ['constatons', 'identifions', 'relevons', 'observons', 'décelons', 'remarquons', 'notons'],
  'détecter': ['constater', 'identifier', 'relever', 'observer', 'déceler', 'remarquer', 'noter'],
  'observer': ['constater', 'remarquer', 'relever', 'examiner', 'analyser', 'noter', 'déceler'],
  'observons': ['constatons', 'remarquons', 'relevons', 'examinons', 'analysons', 'notons', 'décelons'],
  'observé': ['constaté', 'remarqué', 'relevé', 'examiné', 'analysé', 'noté', 'décelé'],
  'constater': ['observer', 'remarquer', 'relever', 'reconnaître', 'établir', 'noter', 'identifier'],
  'constatons': ['observons', 'remarquons', 'relevons', 'reconnaissons', 'établissons', 'notons', 'identifions'],
  'constaté': ['observé', 'remarqué', 'relevé', 'reconnu', 'établi', 'noté', 'identifié'],
  'remarquer': ['constater', 'observer', 'relever', 'noter', 'déceler', 'identifier', 'repérer'],
  'remarqué': ['constaté', 'observé', 'relevé', 'noté', 'décelé', 'identifié', 'repéré'],
  'identifier': ['reconnaître', 'repérer', 'détecter', 'établir', 'déceler', 'localiser', 'déterminer'],
  'identifié': ['reconnu', 'repéré', 'détecté', 'établi', 'décelé', 'localisé', 'déterminé'],
  'trouver': ['découvrir', 'repérer', 'localiser', 'identifier', 'déceler', 'détecter'],
  'trouvé': ['découvert', 'repéré', 'localisé', 'identifié', 'décelé', 'détecté'],
  'découvrir': ['trouver', 'repérer', 'identifier', 'déceler', 'détecter', 'localiser'],
  'découvert': ['trouvé', 'repéré', 'identifié', 'décelé', 'détecté', 'localisé'],
  'noter': ['constater', 'remarquer', 'relever', 'observer', 'consigner', 'signaler'],
  'notez': ['constatez', 'remarquez', 'relevez', 'observez', 'consignez', 'signalez'],

  // --- Action / exécution ---
  'procéder': ['effectuer', 'réaliser', 'accomplir', 'opérer', 'exécuter', 'entreprendre', 'engager'],
  'procédez': ['effectuez', 'réalisez', 'accomplissez', 'opérez', 'exécutez', 'entreprenez', 'engagez'],
  'effectuer': ['réaliser', 'accomplir', 'procéder à', 'opérer', 'exécuter', 'entreprendre', 'mener'],
  'effectuez': ['réalisez', 'accomplissez', 'procédez à', 'opérez', 'exécutez', 'entreprenez', 'menez'],
  'effectué': ['réalisé', 'accompli', 'opéré', 'exécuté', 'entrepris', 'mené'],
  'réaliser': ['effectuer', 'accomplir', 'exécuter', 'mener à bien', 'opérer', 'entreprendre', 'concrétiser'],
  'réalisez': ['effectuez', 'accomplissez', 'exécutez', 'menez à bien', 'opérez', 'entreprenez', 'concrétisez'],
  'réalisé': ['effectué', 'accompli', 'exécuté', 'opéré', 'entrepris', 'concrétisé', 'mené à bien'],
  'exécuter': ['réaliser', 'accomplir', 'effectuer', 'opérer', 'procéder à', 'mener', 'entreprendre'],
  'exécutez': ['réalisez', 'accomplissez', 'effectuez', 'opérez', 'procédez à', 'menez', 'entreprenez'],
  'compléter': ['finaliser', 'achever', 'terminer', 'parachever', 'clôturer', 'boucler', 'conclure'],
  'complétez': ['finalisez', 'achevez', 'terminez', 'parachevez', 'clôturez', 'bouclez', 'concluez'],
  'complété': ['finalisé', 'achevé', 'terminé', 'parachevé', 'clôturé', 'bouclé', 'conclu'],
  'finaliser': ['compléter', 'achever', 'terminer', 'clôturer', 'boucler', 'parachever', 'conclure'],
  'finalisez': ['complétez', 'achevez', 'terminez', 'clôturez', 'bouclez', 'parachevez', 'concluez'],
  'finalisé': ['complété', 'achevé', 'terminé', 'clôturé', 'bouclé', 'parachevé', 'conclu'],
  'terminer': ['achever', 'finaliser', 'clôturer', 'compléter', 'boucler', 'parachever', 'conclure'],
  'terminez': ['achevez', 'finalisez', 'clôturez', 'complétez', 'bouclez', 'parachevez', 'concluez'],
  'terminé': ['achevé', 'finalisé', 'clôturé', 'complété', 'bouclé', 'parachevé', 'conclu'],
  'commencer': ['débuter', 'entamer', 'amorcer', 'initier', 'engager', 'lancer', 'démarrer'],
  'commencez': ['débutez', 'entamez', 'amorcez', 'initiez', 'engagez', 'lancez', 'démarrez'],
  'lancer': ['démarrer', 'initier', 'entamer', 'engager', 'amorcer', 'débuter', 'déclencher'],
  'lancez': ['démarrez', 'initiez', 'entamez', 'engagez', 'amorcez', 'débutez', 'déclenchez'],
  'démarrer': ['lancer', 'commencer', 'entamer', 'initier', 'amorcer', 'débuter', 'engager'],

  // --- Sécurité / protection ---
  'protéger': ['préserver', 'sécuriser', 'sauvegarder', 'défendre', 'garantir'],
  'protégez': ['préservez', 'sécurisez', 'sauvegardez', 'défendez', 'garantissez'],
  'protégé': ['préservé', 'sécurisé', 'sauvegardé', 'défendu', 'garanti'],
  'sauvegarder': ['préserver', 'protéger', 'conserver', 'enregistrer', 'sécuriser', 'archiver'],
  'sauvegardez': ['préservez', 'protégez', 'conservez', 'enregistrez', 'sécurisez', 'archivez'],
  'sauvegardé': ['préservé', 'protégé', 'conservé', 'enregistré', 'sécurisé', 'archivé'],
  'préserver': ['protéger', 'sauvegarder', 'maintenir', 'conserver', 'sécuriser', 'défendre'],
  'préservez': ['protégez', 'sauvegardez', 'maintenez', 'conservez', 'sécurisez', 'défendez'],
  'préservé': ['protégé', 'sauvegardé', 'maintenu', 'conservé', 'sécurisé', 'défendu'],
  'sécuriser': ['protéger', 'préserver', 'sauvegarder', 'défendre', 'garantir'],
  'sécurisez': ['protégez', 'préservez', 'sauvegardez', 'défendez', 'garantissez'],

  // --- Garantir / assurer ---
  'garantir': ['assurer', 'offrir', 'procurer', 'maintenir', 'préserver', 'sécuriser', 'permettre'],
  'garantissons': ['assurons', 'offrons', 'procurons', 'maintenons', 'préservons', 'sécurisons', 'permettons'],
  'garantit': ['assure', 'offre', 'procure', 'maintient', 'préserve', 'sécurise', 'permet'],
  'garanti': ['assuré', 'offert', 'procuré', 'maintenu', 'préservé', 'sécurisé', 'permis'],
  'assurer': ['garantir', 'offrir', 'procurer', 'maintenir', 'préserver', 'permettre'],
  'assurez': ['garantissez', 'offrez', 'procurez', 'maintenez', 'préservez', 'permettez'],
  'assurons': ['garantissons', 'offrons', 'procurons', 'maintenons', 'préservons', 'permettons'],
  'assure': ['garantit', 'offre', 'procure', 'maintient', 'préserve', 'permet'],
  'assuré': ['garanti', 'offert', 'procuré', 'maintenu', 'préservé', 'permis'],
  'offrir': ['procurer', 'garantir', 'assurer', 'permettre', 'proposer', 'fournir'],
  'offre': ['procure', 'garantit', 'assure', 'permet', 'propose', 'fournit'],
  'permettre': ['autoriser', 'garantir', 'assurer', 'offrir', 'procurer', 'rendre possible'],
  'permet': ['autorise', 'garantit', 'assure', 'offre', 'procure', 'rend possible'],

  // --- Optimiser / améliorer ---
  'optimiser': ['améliorer', 'perfectionner', 'affiner', 'bonifier', 'rehausser'],
  'optimisé': ['amélioré', 'perfectionné', 'affiné', 'bonifié', 'rehaussé'],
  'améliorer': ['perfectionner', 'optimiser', 'affiner', 'bonifier', 'rehausser', 'enrichir'],
  'améliorez': ['perfectionnez', 'optimisez', 'affinez', 'bonifiez', 'rehaussez', 'enrichissez'],
  'amélioré': ['perfectionné', 'optimisé', 'affiné', 'bonifié', 'rehaussé', 'enrichi'],

  // --- Nécessité (verbes) ---
  'nécessiter': ['requérir', 'exiger', 'impliquer', 'demander', 'réclamer'],
  'nécessite': ['requiert', 'exige', 'implique', 'demande', 'réclame'],
  'exiger': ['requérir', 'nécessiter', 'imposer', 'réclamer', 'demander'],
  'exige': ['requiert', 'nécessite', 'impose', 'réclame', 'demande'],
  'requérir': ['nécessiter', 'exiger', 'demander', 'réclamer', 'impliquer'],
  'requiert': ['nécessite', 'exige', 'demande', 'réclame', 'implique'],

  // --- Mise à jour / modification ---
  'actualiser': ['renouveler', 'rafraîchir', 'réviser', 'mettre à jour', 'moderniser', 'réactualiser'],
  'mettre à jour': ['actualiser', 'renouveler', 'rafraîchir', 'réviser', 'moderniser', 'réactualiser'],
  'actualisez': ['renouvelez', 'rafraîchissez', 'révisez', 'mettez à jour', 'modernisez', 'réactualisez'],
  'actualisé': ['renouvelé', 'rafraîchi', 'révisé', 'mis à jour', 'modernisé', 'réactualisé'],
  'modifier': ['changer', 'ajuster', 'réviser', 'adapter', 'transformer', 'actualiser', 'corriger'],
  'modifiez': ['changez', 'ajustez', 'révisez', 'adaptez', 'transformez', 'actualisez', 'corrigez'],
  'modifié': ['changé', 'ajusté', 'révisé', 'adapté', 'transformé', 'actualisé', 'corrigé'],
  'changer': ['modifier', 'ajuster', 'renouveler', 'transformer', 'remplacer', 'actualiser'],
  'changez': ['modifiez', 'ajustez', 'renouvelez', 'transformez', 'remplacez', 'actualisez'],
  'ajuster': ['adapter', 'régler', 'modifier', 'affiner', 'aligner', 'accorder'],
  'ajustez': ['adaptez', 'réglez', 'modifiez', 'affinez', 'alignez', 'accordez'],
  'adapter': ['ajuster', 'accommoder', 'aligner', 'conformer', 'accorder', 'régler'],
  'adaptez': ['ajustez', 'accommodez', 'alignez', 'conformez', 'accordez', 'réglez'],
  'renouveler': ['actualiser', 'reconduire', 'proroger', 'rétablir', 'régénérer', 'moderniser'],
  'renouvelez': ['actualisez', 'reconduisez', 'prorogez', 'rétablissez', 'régénérez', 'modernisez'],
  'renouvelé': ['actualisé', 'reconduit', 'prorogé', 'rétabli', 'régénéré', 'modernisé'],
  'corriger': ['rectifier', 'modifier', 'réviser', 'amender', 'redresser', 'ajuster'],
  'corrigez': ['rectifiez', 'modifiez', 'révisez', 'amendez', 'redressez', 'ajustez'],
  'corrigé': ['rectifié', 'modifié', 'révisé', 'amendé', 'redressé', 'ajusté'],
  'rectifier': ['corriger', 'modifier', 'ajuster', 'amender', 'redresser', 'réviser'],

  // --- Interaction utilisateur ---
  'cliquer': ['appuyer', 'presser', 'sélectionner', 'actionner', 'toucher'],
  'cliquez': ['appuyez', 'pressez', 'sélectionnez', 'actionnez', 'touchez'],
  'sélectionner': ['choisir', 'retenir', 'désigner', 'cocher', 'opter pour', 'préférer'],
  'sélectionnez': ['choisissez', 'retenez', 'désignez', 'cochez', 'optez pour', 'préférez'],
  'choisir': ['sélectionner', 'retenir', 'désigner', 'opter pour', 'préférer', 'cocher'],
  'choisissez': ['sélectionnez', 'retenez', 'désignez', 'optez pour', 'préférez', 'cochez'],
  'valider': ['confirmer', 'approuver', 'entériner', 'homologuer', 'certifier', 'ratifier', 'attester'],
  'validez': ['confirmez', 'approuvez', 'entérinez', 'homologuez', 'certifiez', 'ratifiez', 'attestez'],
  'validé': ['confirmé', 'approuvé', 'entériné', 'homologué', 'certifié', 'ratifié', 'attesté'],
  'confirmer': ['valider', 'attester', 'certifier', 'entériner', 'approuver', 'ratifier'],
  'confirmez': ['validez', 'attestez', 'certifiez', 'entérinez', 'approuvez', 'ratifiez'],
  'confirmé': ['validé', 'attesté', 'certifié', 'entériné', 'approuvé', 'ratifié'],
  'saisir': ['entrer', 'renseigner', 'inscrire', 'introduire', 'noter', 'consigner'],
  'saisissez': ['entrez', 'renseignez', 'inscrivez', 'introduisez', 'notez', 'consignez'],
  'entrer': ['saisir', 'renseigner', 'inscrire', 'introduire', 'noter', 'consigner'],
  'entrez': ['saisissez', 'renseignez', 'inscrivez', 'introduisez', 'notez', 'consignez'],
  'remplir': ['compléter', 'renseigner', 'saisir', 'garnir'],
  'remplissez': ['complétez', 'renseignez', 'saisissez', 'garnissez'],
  'renseigner': ['saisir', 'entrer', 'compléter', 'indiquer', 'inscrire', 'préciser'],
  'renseignez': ['saisissez', 'entrez', 'complétez', 'indiquez', 'inscrivez', 'précisez'],
  'indiquer': ['préciser', 'mentionner', 'signaler', 'renseigner', 'noter', 'montrer', 'spécifier'],
  'indiquez': ['précisez', 'mentionnez', 'signalez', 'renseignez', 'notez', 'montrez', 'spécifiez'],
  'mentionner': ['indiquer', 'signaler', 'préciser', 'citer', 'noter', 'évoquer'],
  'préciser': ['spécifier', 'détailler', 'indiquer', 'clarifier', 'mentionner', 'expliciter'],
  'précisez': ['spécifiez', 'détaillez', 'indiquez', 'clarifiez', 'mentionnez', 'explicitez'],

  // --- Communication ---
  'contacter': ['joindre', 'solliciter', 'appeler'],
  'contactez': ['joignez', 'sollicitez', 'appelez'],
  'joindre': ['contacter', 'solliciter', 'appeler'],
  'joignez': ['contactez', 'sollicitez', 'appelez'],
  'répondre': ['répliquer', 'donner suite', 'réagir', 'rétorquer', 'accuser réception'],
  'répondez': ['répliquez', 'donnez suite', 'réagissez', 'rétorquez', 'accusez réception'],
  'signaler': ['indiquer', 'notifier', 'informer', 'communiquer', 'annoncer', 'mentionner', 'préciser'],
  'signalez': ['indiquez', 'notifiez', 'informez', 'communiquez', 'annoncez', 'mentionnez', 'précisez'],
  'notifier': ['signaler', 'informer', 'communiquer', 'annoncer', 'aviser', 'prévenir', 'indiquer'],
  'notifiez': ['signalez', 'informez', 'communiquez', 'annoncez', 'avisez', 'prévenez', 'indiquez'],
  'informer': ['prévenir', 'notifier', 'aviser', 'signaler', 'communiquer', 'renseigner', 'annoncer'],
  'informez': ['prévenez', 'notifiez', 'avisez', 'signalez', 'communiquez', 'renseignez', 'annoncez'],
  'prévenir': ['informer', 'avertir', 'notifier', 'aviser', 'signaler', 'alerter'],
  'prévenez': ['informez', 'avertissez', 'notifiez', 'avisez', 'signalez', 'alertez'],
  'avertir': ['prévenir', 'informer', 'notifier', 'signaler', 'aviser', 'alerter'],
  'avertissez': ['prévenez', 'informez', 'notifiez', 'signalez', 'avisez', 'alertez'],
  'communiquer': ['transmettre', 'partager', 'faire parvenir', 'diffuser', 'relayer', 'notifier', 'adresser'],
  'communiquez': ['transmettez', 'partagez', 'faites parvenir', 'diffusez', 'relayez', 'notifiez', 'adressez'],
  'communiqué': ['transmis', 'partagé', 'diffusé', 'relayé', 'notifié', 'adressé'],
  'transmettre': ['communiquer', 'faire parvenir', 'relayer', 'acheminer', 'adresser', 'diffuser', 'envoyer'],
  'transmettez': ['communiquez', 'faites parvenir', 'relayez', 'acheminez', 'adressez', 'diffusez', 'envoyez'],
  'transmis': ['communiqué', 'relayé', 'acheminé', 'adressé', 'diffusé', 'envoyé'],
  'envoyer': ['transmettre', 'expédier', 'adresser', 'faire parvenir', 'acheminer', 'communiquer', 'relayer'],
  'envoyez': ['transmettez', 'expédiez', 'adressez', 'faites parvenir', 'acheminez', 'communiquez', 'relayez'],
  'envoyé': ['transmis', 'expédié', 'adressé', 'acheminé', 'communiqué', 'relayé'],
  'adresser': ['envoyer', 'transmettre', 'faire parvenir', 'communiquer', 'expédier'],
  'adressez': ['envoyez', 'transmettez', 'faites parvenir', 'communiquez', 'expédiez'],

  // --- Connaissance / information ---
  'connaître': ['savoir', 'maîtriser', 'être informé de', 'avoir connaissance de'],
  'comprendre': ['saisir', 'appréhender', 'concevoir', 'assimiler', 'percevoir'],
  'comprenez': ['saisissez', 'appréhendez', 'concevez', 'assimilez', 'percevez'],
  'expliquer': ['exposer', 'préciser', 'détailler', 'clarifier', 'éclaircir', 'développer'],
  'expliquez': ['exposez', 'précisez', 'détaillez', 'clarifiez', 'éclaircissez', 'développez'],
  'clarifier': ['éclaircir', 'expliquer', 'préciser', 'élucider', 'détailler', 'exposer'],
  'clarifiez': ['éclaircissez', 'expliquez', 'précisez', 'élucidez', 'détaillez', 'exposez'],

  // --- Contrôle / vigilance ---
  'surveiller': ['contrôler', 'observer', 'superviser', 'monitorer', 'suivre'],
  'surveillez': ['contrôlez', 'observez', 'supervisez', 'monitorez', 'suivez'],
  'contrôler': ['vérifier', 'inspecter', 'examiner', 'auditer', 'superviser', 'analyser'],
  'contrôlez': ['vérifiez', 'inspectez', 'examinez', 'auditez', 'supervisez', 'analysez'],
  'vérifier': ['contrôler', 'examiner', 'confirmer', 'valider', 'inspecter', 'attester', 'authentifier'],
  'vérifiez': ['contrôlez', 'examinez', 'confirmez', 'validez', 'inspectez', 'attestez', 'authentifiez'],
  'vérifié': ['contrôlé', 'examiné', 'confirmé', 'validé', 'inspecté', 'attesté', 'authentifié'],
  'examiner': ['analyser', 'étudier', 'inspecter', 'contrôler', 'auditer', 'ausculter'],
  'examinez': ['analysez', 'étudiez', 'inspectez', 'contrôlez', 'auditez', 'ausculter'],
  'analyser': ['examiner', 'étudier', 'évaluer', 'inspecter', 'ausculter', 'décortiquer'],
  'analysez': ['examinez', 'étudiez', 'évaluez', 'inspectez', 'auscultez', 'décortiquez'],
  'évaluer': ['estimer', 'apprécier', 'analyser', 'mesurer', 'juger', 'examiner'],
  'évaluez': ['estimez', 'appréciez', 'analysez', 'mesurez', 'jugez', 'examinez'],

  // --- Autres verbes courants ---
  'utiliser': ['employer', 'exploiter', 'se servir de', 'recourir à', 'user de', 'mobiliser'],
  'utilisez': ['employez', 'exploitez', 'servez-vous de', 'recourez à', 'usez de', 'mobilisez'],
  'utilisé': ['employé', 'exploité', 'mobilisé'],
  'employer': ['utiliser', 'exploiter', 'recourir à', 'se servir de', 'user de', 'mobiliser'],
  'accéder': ['entrer', 'parvenir', 'atteindre', 'joindre', 'gagner'],
  'accédez': ['entrez', 'parvenez à', 'atteignez', 'joignez', 'gagnez'],
  'obtenir': ['recevoir', 'récupérer', 'acquérir', 'gagner', 'décrocher'],
  'obtenez': ['recevez', 'récupérez', 'acquérez', 'gagnez', 'décrochez'],
  'obtenu': ['reçu', 'récupéré', 'acquis', 'gagné', 'décroché'],
  'récupérer': ['retrouver', 'reprendre', 'obtenir', 'recouvrer', 'regagner'],
  'récupérez': ['retrouvez', 'reprenez', 'obtenez', 'recouvrez', 'regagnez'],
  'restaurer': ['rétablir', 'récupérer', 'reconstituer', 'restituer', 'remettre en état'],
  'restaurez': ['rétablissez', 'récupérez', 'reconstituez', 'restituez', 'remettez en état'],
  'restauré': ['rétabli', 'récupéré', 'reconstitué', 'restitué', 'remis en état'],
  'rétablir': ['restaurer', 'reconstituer', 'restituer', 'remettre en état', 'récupérer'],
  'rétablissez': ['restaurez', 'reconstituez', 'restituez', 'remettez en état', 'récupérez'],
  'rétabli': ['restauré', 'reconstitué', 'restitué', 'remis en état', 'récupéré'],
  'suspendre': ['interrompre', 'ajourner', 'reporter', 'geler', 'stopper'],
  'suspendu': ['interrompu', 'ajourné', 'reporté', 'gelé', 'stoppé'],
  'bloquer': ['empêcher', 'suspendre', 'geler', 'stopper', 'entraver'],
  'bloqué': ['suspendu', 'gelé', 'interrompu', 'stoppé', 'entravé'],
  'débloquer': ['libérer', 'lever', 'restaurer', 'dégager', 'réactiver'],
  'activer': ['enclencher', 'lancer', 'mettre en marche', 'déclencher', 'réactiver'],
  'activez': ['enclenchez', 'lancez', 'mettez en marche', 'déclenchez', 'réactivez'],
  'activé': ['enclenché', 'lancé', 'déclenché', 'réactivé'],
  'désactiver': ['arrêter', 'interrompre', 'suspendre', 'stopper', 'inhiber'],
  'désactivé': ['arrêté', 'interrompu', 'suspendu', 'stoppé', 'inhibé'],
  'recevoir': ['obtenir', 'récupérer', 'accueillir', 'percevoir'],
  'recevez': ['obtenez', 'récupérez', 'accueillez', 'percevez'],
  'reçu': ['obtenu', 'récupéré', 'accueilli', 'perçu'],


  // ═══════════════════════════════════════════════════════════════
  // NOMS — genre grammatical préservé
  // ═══════════════════════════════════════════════════════════════

  // --- Problèmes (masculin) ---
  'problème': ['souci', 'incident', 'dysfonctionnement', 'défaut', 'ennui', 'désagrément'],
  'problèmes': ['soucis', 'incidents', 'dysfonctionnements', 'défauts', 'ennuis', 'désagréments'],
  'incident': ['événement', 'problème', 'dysfonctionnement', 'souci', 'contretemps'],
  'incidents': ['événements', 'problèmes', 'dysfonctionnements', 'soucis', 'contretemps'],
  'dysfonctionnement': ['problème', 'incident', 'défaut', 'défaillance', 'souci'],
  'dysfonctionnements': ['problèmes', 'incidents', 'défauts', 'défaillances', 'soucis'],
  'défaut': ['problème', 'dysfonctionnement', 'vice', 'incident'],
  'défauts': ['problèmes', 'dysfonctionnements', 'vices', 'incidents'],
  'risque': ['danger', 'péril', 'aléa', 'menace'],
  'risques': ['dangers', 'périls', 'aléas', 'menaces'],
  'danger': ['risque', 'péril', 'menace', 'aléa'],
  'dangers': ['risques', 'périls', 'menaces', 'aléas'],

  // --- Problèmes (féminin) ---
  'anomalie': ['irrégularité', 'défaillance', 'incohérence', 'aberration'],
  'anomalies': ['irrégularités', 'défaillances', 'incohérences', 'aberrations'],
  'irrégularité': ['anomalie', 'défaillance', 'incohérence', 'inexactitude'],
  'irrégularités': ['anomalies', 'défaillances', 'incohérences', 'inexactitudes'],
  'faille': ['vulnérabilité', 'brèche', 'faiblesse', 'lacune', 'défaut'],
  'failles': ['vulnérabilités', 'brèches', 'faiblesses', 'lacunes', 'défauts'],
  'erreur': ['inexactitude', 'méprise', 'faute', 'anomalie', 'irrégularité'],
  'erreurs': ['inexactitudes', 'méprises', 'fautes', 'anomalies', 'irrégularités'],
  'vulnérabilité': ['faille', 'faiblesse', 'brèche', 'défaut'],
  'vulnérabilités': ['failles', 'faiblesses', 'brèches', 'défauts'],
  'menace': ['danger', 'risque', 'péril', 'intimidation'],
  'menaces': ['dangers', 'risques', 'périls', 'intimidations'],

  // --- Information / données (féminin) ---
  'informations': ['données', 'renseignements', 'coordonnées', 'précisions', 'éléments'],
  'données': ['informations', 'renseignements', 'éléments', 'précisions', 'coordonnées'],
  'renseignements': ['informations', 'précisions', 'détails', 'coordonnées', 'éléments'],
  'précisions': ['détails', 'clarifications', 'informations', 'renseignements', 'éléments'],
  'coordonnées': ['informations', 'renseignements', 'données', 'éléments'],

  // --- Information (masculin) ---
  'détails': ['précisions', 'éléments', 'renseignements', 'informations', 'points'],
  'éléments': ['informations', 'renseignements', 'détails', 'précisions', 'points'],
  'document': ['fichier', 'formulaire', 'écrit', 'support'],
  'documents': ['fichiers', 'formulaires', 'écrits', 'supports'],
  'fichier': ['document', 'formulaire', 'support'],
  'fichiers': ['documents', 'formulaires', 'supports'],
  'formulaire': ['document', 'fichier', 'imprimé'],
  'formulaires': ['documents', 'fichiers', 'imprimés'],

  // --- Compte / accès (masculin) ---
  'compte': ['espace', 'profil', 'dossier', 'abonnement'],
  'comptes': ['espaces', 'profils', 'dossiers', 'abonnements'],
  'espace': ['compte', 'profil', 'dossier'],
  'espaces': ['comptes', 'profils', 'dossiers'],
  'profil': ['compte', 'espace', 'dossier', 'fiche'],
  'profils': ['comptes', 'espaces', 'dossiers', 'fiches'],
  // 'accès' n'a plus de synonyme substituable en gardant la grammaire :
  // 'connexion', 'entrée', 'ouverture' sont féminins, ce qui casse l'accord
  // de l'article et de l'adjectif qui suit ("un accès sécurisé" → "une connexion sécurisée").
  'identifiant': ['code', 'référence', 'login'],
  'identifiants': ['codes', 'références', 'logins'],
  'dossier': ['compte', 'profil', 'fichier', 'document'],
  'dossiers': ['comptes', 'profils', 'fichiers', 'documents'],

  // --- Connexion (féminin) ---
  'connexion': ['liaison', 'ouverture', 'session'],
  'connexions': ['liaisons', 'ouvertures', 'sessions'],
  'session': ['connexion', 'séance'],
  'sessions': ['connexions', 'séances'],

  // --- Services / prestations ---
  'services': ['prestations', 'offres', 'solutions', 'fonctions'],
  'prestations': ['services', 'offres', 'solutions', 'fournitures'],
  'solution': ['réponse', 'alternative', 'option', 'recours', 'issue'],
  'solutions': ['réponses', 'alternatives', 'options', 'recours', 'issues'],
  'option': ['choix', 'alternative', 'possibilité', 'faculté', 'variante'],
  'options': ['choix', 'alternatives', 'possibilités', 'facultés', 'variantes'],
  'offre': ['proposition', 'prestation', 'service', 'solution'],
  'offres': ['propositions', 'prestations', 'services', 'solutions'],

  // --- Vérification / authentification (féminin) ---
  'identification': ['authentification', 'reconnaissance', 'vérification', 'confirmation'],
  'authentification': ['identification', 'vérification', 'confirmation', 'certification'],
  'vérification': ['contrôle', 'authentification', 'inspection', 'confirmation', 'validation'],
  'vérifications': ['contrôles', 'inspections', 'confirmations', 'validations'],
  'validation': ['confirmation', 'approbation', 'homologation', 'ratification', 'certification'],
  'validations': ['confirmations', 'approbations', 'homologations', 'ratifications'],
  'confirmation': ['validation', 'attestation', 'approbation', 'ratification', 'certification'],
  'confirmations': ['validations', 'attestations', 'approbations', 'ratifications'],
  'certification': ['validation', 'homologation', 'attestation', 'authentification'],
  'certifications': ['validations', 'homologations', 'attestations'],
  'inspection': ['contrôle', 'examen', 'vérification', 'audit'],
  'inspections': ['contrôles', 'examens', 'vérifications', 'audits'],
  'reconnaissance': ['identification', 'authentification', 'validation'],

  // --- Vérification (masculin) ---
  'contrôle': ['vérification', 'examen', 'inspection', 'audit', 'supervision'],
  'contrôles': ['vérifications', 'examens', 'inspections', 'audits', 'supervisions'],
  'audit': ['contrôle', 'inspection', 'examen', 'vérification', 'analyse'],
  'audits': ['contrôles', 'inspections', 'examens', 'vérifications', 'analyses'],
  'examen': ['contrôle', 'inspection', 'analyse', 'étude', 'vérification'],
  'examens': ['contrôles', 'inspections', 'analyses', 'études', 'vérifications'],

  // --- Temps (masculin) ---
  // 'délais' est intentionnellement sans synonyme : dans les expressions
  // figées ("dans les plus brefs délais", "dans les meilleurs délais"),
  // aucun synonyme ne fonctionne sans casser la locution.
  'moment': ['instant', 'temps'],
  'moments': ['instants', 'temps'],

  // --- Temps (féminin) ---
  'échéance': ['date limite', 'expiration', 'date butoir'],
  'échéances': ['dates limites', 'dates butoirs'],
  'période': ['durée', 'phase', 'intervalle'],
  'périodes': ['durées', 'phases', 'intervalles'],
  'durée': ['période', 'phase'],
  'durées': ['périodes', 'phases'],
  'date': ['échéance', 'jour'],
  'dates': ['échéances', 'jours'],

  // --- Structure ---
  'équipe': ['cellule', 'unité'],
  'équipes': ['cellules', 'unités'],
  'département': ['service', 'bureau', 'pôle', 'division', 'section'],
  'départements': ['services', 'bureaux', 'pôles', 'divisions', 'sections'],
  'bureau': ['service', 'département', 'agence', 'cabinet'],
  'bureaux': ['services', 'départements', 'agences', 'cabinets'],
  'division': ['département', 'section', 'branche', 'unité'],
  'divisions': ['départements', 'sections', 'branches', 'unités'],
  'section': ['département', 'division', 'branche', 'partie'],
  'sections': ['départements', 'divisions', 'branches', 'parties'],

  // --- Assistance (féminin) ---
  'assistance': ['aide', 'appui', 'accompagnement', 'entraide'],
  'aide': ['assistance', 'appui', 'accompagnement', 'entraide'],

  // --- Support (masculin) ---
  'support': ['appui', 'accompagnement', 'soutien', 'renfort'],
  'soutien': ['appui', 'accompagnement', 'support', 'renfort'],
  'accompagnement': ['suivi', 'soutien', 'appui', 'assistance', 'encadrement'],
  'appui': ['support', 'soutien', 'accompagnement', 'assistance', 'aide'],

  // --- Plateformes (féminin) ---
  'plateforme': ['interface', 'infrastructure'],
  'plateformes': ['interfaces', 'infrastructures'],
  'interface': ['plateforme', 'panneau'],
  'application': ['logiciel', 'programme', 'outil', 'appli'],
  'applications': ['logiciels', 'programmes', 'outils', 'applis'],
  'page': ['écran', 'interface', 'onglet'],
  'pages': ['écrans', 'interfaces', 'onglets'],

  // --- Plateformes (masculin) ---
  'site': ['portail', 'espace'],
  'sites': ['portails', 'espaces'],
  'portail': ['site', 'espace'],
  'portails': ['sites', 'espaces'],
  'logiciel': ['programme', 'outil', 'application', 'utilitaire'],
  'logiciels': ['programmes', 'outils', 'applications', 'utilitaires'],
  'programme': ['logiciel', 'application', 'outil'],
  'programmes': ['logiciels', 'applications', 'outils'],
  'système': ['dispositif', 'mécanisme', 'infrastructure'],
  'systèmes': ['dispositifs', 'mécanismes', 'infrastructures'],
  'outil': ['logiciel', 'programme', 'application', 'utilitaire'],
  'outils': ['logiciels', 'programmes', 'applications', 'utilitaires'],

  // --- Messagerie ---
  'email': ['courriel', 'mail', 'message'],
  'emails': ['courriels', 'mails', 'messages'],
  'courriel': ['email', 'mail', 'message'],
  'courriels': ['emails', 'mails', 'messages'],
  'message': ['courriel', 'communication', 'notification', 'email'],
  'messages': ['courriels', 'communications', 'notifications', 'emails'],
  'notification': ['message', 'alerte', 'communication', 'avis', 'signalement'],
  'notifications': ['messages', 'alertes', 'communications', 'avis', 'signalements'],
  'communication': ['message', 'notification', 'échange', 'information', 'avis'],
  'communications': ['messages', 'notifications', 'échanges', 'informations', 'avis'],
  'alerte': ['notification', 'avertissement', 'signal', 'avis'],
  'alertes': ['notifications', 'avertissements', 'signaux', 'avis'],
  'avis': ['notification', 'message', 'communication', 'annonce'],

  // --- Personnes / rôles ---
  'client': ['utilisateur', 'abonné', 'usager', 'membre'],
  'clients': ['utilisateurs', 'abonnés', 'usagers', 'membres'],
  'utilisateur': ['client', 'usager', 'abonné', 'membre', 'internaute'],
  'utilisateurs': ['clients', 'usagers', 'abonnés', 'membres', 'internautes'],
  'abonné': ['client', 'membre', 'adhérent', 'usager', 'souscripteur'],
  'abonnés': ['clients', 'membres', 'adhérents', 'usagers', 'souscripteurs'],
  'membre': ['adhérent', 'abonné', 'inscrit', 'affilié'],
  'membres': ['adhérents', 'abonnés', 'inscrits', 'affiliés'],
  'usager': ['utilisateur', 'client', 'abonné'],
  'usagers': ['utilisateurs', 'clients', 'abonnés'],

  // --- Sécurité (féminin) ---
  'sécurité': ['protection', 'sûreté', 'sauvegarde'],
  'protection': ['sécurité', 'sauvegarde', 'préservation'],
  'sûreté': ['sécurité', 'protection', 'fiabilité'],
  'confidentialité': ['discrétion', 'secret'],
  'intégrité': ['authenticité', 'exactitude'],
  'fiabilité': ['crédibilité', 'sûreté', 'solidité'],

  // --- Entités (féminin) ---
  'entreprise': ['société', 'compagnie', 'structure', 'firme', 'maison'],
  'entreprises': ['sociétés', 'compagnies', 'structures', 'firmes', 'maisons'],
  'société': ['entreprise', 'compagnie', 'structure', 'firme'],
  'sociétés': ['entreprises', 'compagnies', 'structures', 'firmes'],
  'compagnie': ['entreprise', 'société', 'firme'],
  'compagnies': ['entreprises', 'sociétés', 'firmes'],
  'organisation': ['structure', 'entité', 'organisme'],
  'organisations': ['structures', 'entités', 'organismes'],
  'institution': ['organisme', 'établissement', 'entité', 'organisation'],
  'institutions': ['organismes', 'établissements', 'entités', 'organisations'],
  'agence': ['bureau', 'antenne', 'succursale'],
  'agences': ['bureaux', 'antennes', 'succursales'],
  'structure': ['organisation', 'entité', 'organisme'],
  'structures': ['organisations', 'entités', 'organismes'],

  // --- Entités (masculin) ---
  'organisme': ['établissement', 'organisation', 'institution', 'entité'],
  'organismes': ['établissements', 'organisations', 'institutions', 'entités'],
  'établissement': ['organisme', 'institution', 'structure'],
  'établissements': ['organismes', 'institutions', 'structures'],

  // --- Concepts (féminin) ---
  'demande': ['requête', 'sollicitation', 'question'],
  'demandes': ['requêtes', 'sollicitations', 'questions'],
  'requête': ['demande', 'sollicitation', 'question'],
  'requêtes': ['demandes', 'sollicitations', 'questions'],
  'procédure': ['démarche', 'marche à suivre', 'méthode', 'protocole'],
  'procédures': ['démarches', 'méthodes', 'protocoles'],
  'démarche': ['procédure', 'approche', 'méthode', 'action'],
  'démarches': ['procédures', 'approches', 'méthodes', 'actions'],
  'méthode': ['approche', 'manière', 'procédé', 'procédure', 'technique'],
  'méthodes': ['approches', 'manières', 'procédés', 'procédures', 'techniques'],
  'condition': ['clause', 'modalité', 'critère', 'exigence', 'stipulation'],
  'conditions': ['clauses', 'modalités', 'critères', 'exigences', 'stipulations'],
  'exigence': ['obligation', 'condition', 'requête', 'nécessité'],
  'exigences': ['obligations', 'conditions', 'requêtes', 'nécessités'],
  'obligation': ['exigence', 'contrainte', 'devoir', 'engagement', 'nécessité'],
  'obligations': ['exigences', 'contraintes', 'devoirs', 'engagements', 'nécessités'],
  'convention': ['accord', 'entente', 'contrat', 'pacte'],
  'conventions': ['accords', 'ententes', 'contrats', 'pactes'],
  'modalité': ['condition', 'clause', 'critère', 'manière'],
  'modalités': ['conditions', 'clauses', 'critères', 'manières'],
  'clause': ['condition', 'modalité', 'stipulation', 'critère'],
  'clauses': ['conditions', 'modalités', 'stipulations', 'critères'],

  // --- Concepts (masculin) ---
  'processus': ['mécanisme', 'déroulement', 'procédé', 'cheminement'],
  'engagement': ['obligation', 'promesse', 'devoir'],
  'engagements': ['obligations', 'promesses', 'devoirs'],
  'contrat': ['accord', 'convention', 'entente', 'pacte'],
  'contrats': ['accords', 'conventions', 'ententes', 'pactes'],
  'accord': ['entente', 'convention', 'pacte', 'contrat'],
  'accords': ['ententes', 'conventions', 'pactes', 'contrats'],
  'critère': ['condition', 'clause', 'exigence', 'modalité'],
  'critères': ['conditions', 'clauses', 'exigences', 'modalités'],


  // ═══════════════════════════════════════════════════════════════
  // ADJECTIFS — accords en genre et nombre respectés
  // ═══════════════════════════════════════════════════════════════

  // --- Relations (féminin pluriel) ---
  'associées': ['liées', 'rattachées', 'relatives', 'attachées', 'reliées', 'connectées'],
  'liées': ['associées', 'rattachées', 'attachées', 'reliées', 'connectées', 'relatives'],
  'rattachées': ['liées', 'associées', 'attachées', 'reliées', 'connectées'],
  'relatives': ['associées', 'liées', 'rattachées', 'attachées', 'concernant'],

  // --- Relations (masculin pluriel) ---
  'associés': ['liés', 'rattachés', 'relatifs', 'attachés', 'reliés', 'connectés'],
  'liés': ['associés', 'rattachés', 'attachés', 'reliés', 'connectés', 'relatifs'],
  'rattachés': ['liés', 'associés', 'attachés', 'reliés', 'connectés'],
  'relatifs': ['associés', 'liés', 'rattachés', 'attachés'],

  // --- Relations (singulier) ---
  'associé': ['lié', 'rattaché', 'relatif', 'attaché', 'relié', 'connecté'],
  'associée': ['liée', 'rattachée', 'relative', 'attachée', 'reliée', 'connectée'],
  'lié': ['associé', 'rattaché', 'attaché', 'relié', 'connecté', 'relatif'],
  'liée': ['associée', 'rattachée', 'attachée', 'reliée', 'connectée', 'relative'],

  // --- Nature numérique ---
  'numérique': ['digital', 'informatique', 'électronique', 'en ligne', 'dématérialisé'],
  'numériques': ['digitaux', 'informatiques', 'électroniques', 'dématérialisés'],
  'digital': ['numérique', 'électronique', 'informatique', 'dématérialisé'],
  'digitale': ['numérique', 'électronique', 'informatique', 'dématérialisée'],
  'digitaux': ['numériques', 'électroniques', 'informatiques', 'dématérialisés'],
  'informatique': ['numérique', 'digital', 'électronique'],
  'informatiques': ['numériques', 'digitaux', 'électroniques'],
  'électronique': ['numérique', 'digital', 'informatique', 'dématérialisé'],
  'électroniques': ['numériques', 'digitaux', 'informatiques', 'dématérialisés'],

  // --- Modernité ---
  'moderne': ['récent', 'actuel', 'contemporain', 'nouveau', 'innovant'],
  'modernes': ['récents', 'actuels', 'contemporains', 'nouveaux', 'innovants'],
  'récent': ['nouveau', 'moderne', 'actuel', 'contemporain', 'neuf'],
  'récente': ['nouvelle', 'moderne', 'actuelle', 'contemporaine', 'neuve'],
  'récents': ['nouveaux', 'modernes', 'actuels', 'contemporains', 'neufs'],
  'récentes': ['nouvelles', 'modernes', 'actuelles', 'contemporaines', 'neuves'],
  'nouveau': ['récent', 'neuf', 'moderne', 'inédit'],
  'nouvelle': ['récente', 'neuve', 'moderne', 'inédite'],
  'nouveaux': ['récents', 'neufs', 'modernes', 'inédits'],
  'nouvelles': ['récentes', 'neuves', 'modernes', 'inédites'],
  'actuel': ['récent', 'moderne', 'contemporain', 'présent'],
  'actuelle': ['récente', 'moderne', 'contemporaine', 'présente'],

  // --- État actif ---
  'actif': ['ouvert', 'fonctionnel', 'valide', 'opérationnel', 'en cours', 'utilisable'],
  'active': ['ouverte', 'fonctionnelle', 'valide', 'opérationnelle', 'en cours', 'utilisable'],
  'actifs': ['ouverts', 'fonctionnels', 'valides', 'opérationnels', 'utilisables'],
  'actives': ['ouvertes', 'fonctionnelles', 'valides', 'opérationnelles', 'utilisables'],
  'inactif': ['fermé', 'suspendu', 'invalide', 'bloqué', 'désactivé', 'inutilisable'],
  'inactive': ['fermée', 'suspendue', 'invalide', 'bloquée', 'désactivée', 'inutilisable'],
  'inactifs': ['fermés', 'suspendus', 'invalides', 'bloqués', 'désactivés', 'inutilisables'],
  'inactives': ['fermées', 'suspendues', 'invalides', 'bloquées', 'désactivées', 'inutilisables'],

  // --- Disponibilité ---
  'disponible': ['accessible', 'utilisable', 'libre', 'ouvert', 'joignable'],
  'disponibles': ['accessibles', 'utilisables', 'libres', 'ouverts', 'joignables'],
  'accessible': ['disponible', 'utilisable', 'ouvert', 'atteignable', 'joignable'],
  'accessibles': ['disponibles', 'utilisables', 'ouverts', 'atteignables', 'joignables'],

  // --- Fonctionnement ---
  'fonctionnel': ['opérationnel', 'actif', 'utilisable', 'performant'],
  'fonctionnelle': ['opérationnelle', 'active', 'utilisable', 'performante'],
  'fonctionnels': ['opérationnels', 'actifs', 'utilisables', 'performants'],
  'fonctionnelles': ['opérationnelles', 'actives', 'utilisables', 'performantes'],
  'opérationnel': ['fonctionnel', 'actif', 'utilisable', 'prêt'],
  'opérationnelle': ['fonctionnelle', 'active', 'utilisable', 'prête'],
  'opérationnels': ['fonctionnels', 'actifs', 'utilisables', 'prêts'],
  'opérationnelles': ['fonctionnelles', 'actives', 'utilisables', 'prêtes'],

  // --- Validité ---
  'valide': ['valable', 'légitime', 'conforme', 'recevable', 'reconnu'],
  'valides': ['valables', 'légitimes', 'conformes', 'recevables', 'reconnus'],
  'valable': ['valide', 'légitime', 'conforme', 'recevable', 'acceptable'],
  'valables': ['valides', 'légitimes', 'conformes', 'recevables', 'acceptables'],
  'expiré': ['périmé', 'échu', 'dépassé', 'obsolète', 'caduc'],
  'expirée': ['périmée', 'échue', 'dépassée', 'obsolète', 'caduque'],
  'expirés': ['périmés', 'échus', 'dépassés', 'obsolètes', 'caducs'],
  'expirées': ['périmées', 'échues', 'dépassées', 'obsolètes', 'caduques'],
  'obsolète': ['dépassé', 'périmé', 'ancien', 'désuet', 'caduc'],
  'obsolètes': ['dépassés', 'périmés', 'anciens', 'désuets', 'caducs'],
  'conforme': ['valide', 'valable', 'régulier', 'correct'],
  'conformes': ['valides', 'valables', 'réguliers', 'corrects'],

  // --- Authenticité ---
  'officiel': ['certifié', 'authentique', 'homologué', 'attesté', 'reconnu', 'validé'],
  'officiels': ['certifiés', 'authentiques', 'homologués', 'attestés', 'reconnus', 'validés'],
  'officielle': ['certifiée', 'authentique', 'homologuée', 'attestée', 'reconnue', 'validée'],
  'officielles': ['certifiées', 'authentiques', 'homologuées', 'attestées', 'reconnues', 'validées'],
  'authentique': ['véritable', 'officiel', 'certifié', 'attesté', 'original', 'légitime'],
  'authentiques': ['véritables', 'officiels', 'certifiés', 'attestés', 'originaux', 'légitimes'],
  'certifié': ['authentique', 'officiel', 'homologué', 'attesté', 'reconnu', 'validé'],
  'certifiée': ['authentique', 'officielle', 'homologuée', 'attestée', 'reconnue', 'validée'],
  'certifiés': ['authentiques', 'officiels', 'homologués', 'attestés', 'reconnus', 'validés'],
  'certifiées': ['authentiques', 'officielles', 'homologuées', 'attestées', 'reconnues', 'validées'],
  'homologué': ['certifié', 'validé', 'approuvé', 'officiel', 'attesté', 'reconnu'],
  'homologuée': ['certifiée', 'validée', 'approuvée', 'officielle', 'attestée', 'reconnue'],
  'homologués': ['certifiés', 'validés', 'approuvés', 'officiels', 'attestés', 'reconnus'],
  'homologuées': ['certifiées', 'validées', 'approuvées', 'officielles', 'attestées', 'reconnues'],
  'approuvé': ['validé', 'entériné', 'homologué', 'accepté', 'agréé', 'ratifié'],
  'approuvée': ['validée', 'entérinée', 'homologuée', 'acceptée', 'agréée', 'ratifiée'],
  'approuvés': ['validés', 'entérinés', 'homologués', 'acceptés', 'agréés', 'ratifiés'],
  'approuvées': ['validées', 'entérinées', 'homologuées', 'acceptées', 'agréées', 'ratifiées'],
  'légitime': ['valable', 'fondé', 'reconnu', 'valide', 'justifié'],
  'légitimes': ['valables', 'fondés', 'reconnus', 'valides', 'justifiés'],

  // --- Sécurité (adjectifs) ---
  'sécurisé': ['protégé', 'fiable', 'sûr', 'préservé'],
  'sécurisée': ['protégée', 'fiable', 'sûre', 'préservée'],
  'sécurisés': ['protégés', 'fiables', 'sûrs', 'préservés'],
  'sécurisées': ['protégées', 'fiables', 'sûres', 'préservées'],
  'protégé': ['sécurisé', 'préservé', 'défendu', 'sauvegardé'],
  'protégée': ['sécurisée', 'préservée', 'défendue', 'sauvegardée'],
  'protégés': ['sécurisés', 'préservés', 'défendus', 'sauvegardés'],
  'protégées': ['sécurisées', 'préservées', 'défendues', 'sauvegardées'],
  'confidentiel': ['privé', 'discret', 'protégé', 'secret', 'personnel'],
  'confidentielle': ['privée', 'discrète', 'protégée', 'secrète', 'personnelle'],
  'confidentiels': ['privés', 'discrets', 'protégés', 'secrets', 'personnels'],
  'confidentielles': ['privées', 'discrètes', 'protégées', 'secrètes', 'personnelles'],
  // 'sensible' est invariable en genre — retirés : délicat/délicate, confidentiel/confidentielle,
  // privé/privée, important/importante. Seul 'critique' est invariable.
  'sensible': ['critique'],
  'sensibles': ['critiques'],
  'fiable': ['sûr', 'sécurisé', 'solide', 'crédible', 'sérieux'],
  'fiables': ['sûrs', 'sécurisés', 'solides', 'crédibles', 'sérieux'],

  // --- Efficacité ---
  // 'fluide' est invariable en genre — ses synonymes doivent l'être aussi
  // (retirés : harmonieux/harmonieuse, régulier/régulière)
  'fluide': ['efficace', 'souple'],
  'fluides': ['efficaces', 'souples'],
  'efficace': ['performant', 'concluant', 'fluide', 'productif', 'opérationnel'],
  'efficaces': ['performants', 'concluants', 'fluides', 'productifs', 'opérationnels'],
  'performant': ['efficace', 'productif', 'opérationnel', 'concluant'],
  'performants': ['efficaces', 'productifs', 'opérationnels', 'concluants'],
  'performante': ['efficace', 'productive', 'opérationnelle', 'concluante'],
  'performantes': ['efficaces', 'productives', 'opérationnelles', 'concluantes'],

  // --- Personnel / propre ---
  'personnel': ['privé', 'individuel', 'particulier', 'propre'],
  'personnels': ['privés', 'individuels', 'particuliers', 'propres'],
  'personnelle': ['privée', 'individuelle', 'particulière', 'propre'],
  'personnelles': ['privées', 'individuelles', 'confidentielles', 'particulières', 'propres'],
  'privé': ['personnel', 'confidentiel', 'individuel', 'particulier'],
  'privée': ['personnelle', 'confidentielle', 'individuelle', 'particulière'],
  'privés': ['personnels', 'confidentiels', 'individuels', 'particuliers'],
  'privées': ['personnelles', 'confidentielles', 'individuelles', 'particulières'],
  'individuel': ['personnel', 'particulier', 'propre', 'privé', 'singulier'],
  'individuelle': ['personnelle', 'particulière', 'propre', 'privée', 'singulière'],
  'individuels': ['personnels', 'particuliers', 'propres', 'privés', 'singuliers'],
  'individuelles': ['personnelles', 'particulières', 'propres', 'privées', 'singulières'],
  'particulier': ['personnel', 'privé', 'individuel', 'propre', 'spécifique'],
  'particulière': ['personnelle', 'privée', 'individuelle', 'propre', 'spécifique'],
  'particuliers': ['personnels', 'privés', 'individuels', 'propres', 'spécifiques'],
  'particulières': ['personnelles', 'privées', 'individuelles', 'propres', 'spécifiques'],
  'spécifique': ['particulier', 'précis', 'défini', 'propre', 'concret'],
  'spécifiques': ['particuliers', 'précis', 'définis', 'propres', 'concrets'],
  'précis': ['exact', 'spécifique', 'défini', 'concret', 'clair'],
  'précise': ['exacte', 'spécifique', 'définie', 'concrète', 'claire'],

  // --- Importance ---
  'important': ['essentiel', 'majeur', 'significatif', 'considérable', 'notable', 'crucial'],
  'importante': ['essentielle', 'majeure', 'significative', 'considérable', 'notable', 'cruciale'],
  'importants': ['essentiels', 'majeurs', 'significatifs', 'considérables', 'notables', 'cruciaux'],
  'importantes': ['essentielles', 'majeures', 'significatives', 'considérables', 'notables', 'cruciales'],
  'essentiel': ['fondamental', 'capital', 'primordial', 'crucial', 'indispensable', 'majeur'],
  'essentielle': ['fondamentale', 'capitale', 'primordiale', 'cruciale', 'indispensable', 'majeure'],
  'essentiels': ['fondamentaux', 'capitaux', 'primordiaux', 'cruciaux', 'indispensables', 'majeurs'],
  'essentielles': ['fondamentales', 'capitales', 'primordiales', 'cruciales', 'indispensables', 'majeures'],
  'majeur': ['important', 'considérable', 'essentiel', 'principal', 'notable'],
  'majeure': ['importante', 'considérable', 'essentielle', 'principale', 'notable'],
  'majeurs': ['importants', 'considérables', 'essentiels', 'principaux', 'notables'],
  'majeures': ['importantes', 'considérables', 'essentielles', 'principales', 'notables'],
  'primordial': ['essentiel', 'fondamental', 'capital', 'crucial', 'majeur'],
  'primordiale': ['essentielle', 'fondamentale', 'capitale', 'cruciale', 'majeure'],
  'primordiaux': ['essentiels', 'fondamentaux', 'capitaux', 'cruciaux', 'majeurs'],
  'primordiales': ['essentielles', 'fondamentales', 'capitales', 'cruciales', 'majeures'],
  'fondamental': ['essentiel', 'capital', 'primordial', 'crucial', 'majeur'],
  'fondamentale': ['essentielle', 'capitale', 'primordiale', 'cruciale', 'majeure'],
  'fondamentaux': ['essentiels', 'capitaux', 'primordiaux', 'cruciaux', 'majeurs'],
  'fondamentales': ['essentielles', 'capitales', 'primordiales', 'cruciales', 'majeures'],
  'crucial': ['essentiel', 'capital', 'décisif', 'primordial', 'critique'],
  'cruciale': ['essentielle', 'capitale', 'décisive', 'primordiale', 'critique'],
  'cruciaux': ['essentiels', 'capitaux', 'décisifs', 'primordiaux', 'critiques'],
  'cruciales': ['essentielles', 'capitales', 'décisives', 'primordiales', 'critiques'],
  'capital': ['essentiel', 'fondamental', 'primordial', 'crucial', 'majeur'],
  'capitale': ['essentielle', 'fondamentale', 'primordiale', 'cruciale', 'majeure'],
  'significatif': ['notable', 'considérable', 'important', 'remarquable'],
  'significative': ['notable', 'considérable', 'importante', 'remarquable'],
  'significatifs': ['notables', 'considérables', 'importants', 'remarquables'],
  'significatives': ['notables', 'considérables', 'importantes', 'remarquables'],
  'notable': ['significatif', 'remarquable', 'considérable', 'important'],
  'notables': ['significatifs', 'remarquables', 'considérables', 'importants'],
  'considérable': ['important', 'majeur', 'notable', 'significatif', 'substantiel'],
  'considérables': ['importants', 'majeurs', 'notables', 'significatifs', 'substantiels'],
  'principal': ['majeur', 'essentiel', 'central', 'premier', 'primordial'],
  'principale': ['majeure', 'essentielle', 'centrale', 'première', 'primordiale'],
  'principaux': ['majeurs', 'essentiels', 'centraux', 'premiers', 'primordiaux'],
  'principales': ['majeures', 'essentielles', 'centrales', 'premières', 'primordiales'],

  // --- Impératif / obligatoire ---
  'impératif': ['essentiel', 'nécessaire', 'indispensable', 'obligatoire', 'primordial', 'requis', 'crucial'],
  'impérative': ['essentielle', 'nécessaire', 'indispensable', 'obligatoire', 'primordiale', 'requise', 'cruciale'],
  'impératifs': ['essentiels', 'nécessaires', 'indispensables', 'obligatoires', 'primordiaux', 'requis', 'cruciaux'],
  'impératives': ['essentielles', 'nécessaires', 'indispensables', 'obligatoires', 'primordiales', 'requises', 'cruciales'],
  'nécessaire': ['indispensable', 'obligatoire', 'essentiel', 'requis', 'impératif', 'utile', 'primordial'],
  'nécessaires': ['indispensables', 'obligatoires', 'essentiels', 'requis', 'impératifs', 'utiles', 'primordiaux'],
  'obligatoire': ['impératif', 'nécessaire', 'indispensable', 'requis', 'imposé', 'essentiel'],
  'obligatoires': ['impératifs', 'nécessaires', 'indispensables', 'requis', 'imposés', 'essentiels'],
  'requis': ['nécessaire', 'obligatoire', 'demandé', 'attendu', 'impératif', 'exigé'],
  'requise': ['nécessaire', 'obligatoire', 'demandée', 'attendue', 'impérative', 'exigée'],
  'indispensable': ['essentiel', 'nécessaire', 'obligatoire', 'impératif', 'primordial', 'crucial'],
  'indispensables': ['essentiels', 'nécessaires', 'obligatoires', 'impératifs', 'primordiaux', 'cruciaux'],

  // --- Urgence ---
  'urgent': ['pressant', 'prioritaire', 'immédiat', 'critique', 'impératif'],
  'urgente': ['pressante', 'prioritaire', 'immédiate', 'critique', 'impérative'],
  'urgents': ['pressants', 'prioritaires', 'immédiats', 'critiques', 'impératifs'],
  'urgentes': ['pressantes', 'prioritaires', 'immédiates', 'critiques', 'impératives'],
  'immédiat': ['instantané', 'direct', 'urgent', 'prompt'],
  'immédiate': ['instantanée', 'directe', 'urgente', 'prompte'],
  'immédiats': ['instantanés', 'directs', 'urgents', 'prompts'],
  'immédiates': ['instantanées', 'directes', 'urgentes', 'promptes'],
  'pressant': ['urgent', 'impératif', 'prioritaire'],
  'pressante': ['urgente', 'impérative', 'prioritaire'],
  // 'critique' est invariable en genre — tous ses anciens synonymes étaient variables,
  // ce qui cassait l'accord (crucial/cruciale, délicat/délicate, sérieux/sérieuse,
  // grave/grave OK, décisif/décisive). On garde uniquement 'grave' qui est invariable.
  'critique': ['grave'],
  'critiques': ['graves'],
  'grave': ['sérieux', 'sévère', 'critique', 'important'],
  'graves': ['sérieux', 'sévères', 'critiques', 'importants'],
  'prioritaire': ['urgent', 'principal', 'essentiel', 'impératif'],
  'prioritaires': ['urgents', 'principaux', 'essentiels', 'impératifs'],

  // --- Autres qualificatifs ---
  'complet': ['entier', 'intégral', 'exhaustif', 'total', 'plein'],
  'complète': ['entière', 'intégrale', 'exhaustive', 'totale', 'pleine'],
  'complets': ['entiers', 'intégraux', 'exhaustifs', 'totaux', 'pleins'],
  'complètes': ['entières', 'intégrales', 'exhaustives', 'totales', 'pleines'],
  'total': ['complet', 'entier', 'intégral', 'global', 'plein'],
  'totale': ['complète', 'entière', 'intégrale', 'globale', 'pleine'],
  'totaux': ['complets', 'entiers', 'intégraux', 'globaux', 'pleins'],
  'totales': ['complètes', 'entières', 'intégrales', 'globales', 'pleines'],
  'entier': ['complet', 'total', 'intégral', 'plein'],
  'entière': ['complète', 'totale', 'intégrale', 'pleine'],
  'entiers': ['complets', 'totaux', 'intégraux', 'pleins'],
  'entières': ['complètes', 'totales', 'intégrales', 'pleines'],
  'clair': ['évident', 'précis', 'compréhensible', 'limpide', 'net'],
  'claire': ['évidente', 'précise', 'compréhensible', 'limpide', 'nette'],
  'clairs': ['évidents', 'précis', 'compréhensibles', 'limpides', 'nets'],
  'claires': ['évidentes', 'précises', 'compréhensibles', 'limpides', 'nettes'],
  'évident': ['clair', 'manifeste', 'apparent', 'flagrant', 'incontestable'],
  'évidente': ['claire', 'manifeste', 'apparente', 'flagrante', 'incontestable'],
  'évidents': ['clairs', 'manifestes', 'apparents', 'flagrants', 'incontestables'],
  'évidentes': ['claires', 'manifestes', 'apparentes', 'flagrantes', 'incontestables'],
  'simple': ['basique', 'élémentaire', 'facile', 'aisé'],
  'simples': ['basiques', 'élémentaires', 'faciles', 'aisés'],
  'facile': ['simple', 'aisé', 'accessible', 'commode', 'praticable'],
  'faciles': ['simples', 'aisés', 'accessibles', 'commodes', 'praticables'],
  'rapide': ['prompt', 'immédiat', 'expéditif', 'accéléré', 'véloce'],
  'rapides': ['prompts', 'immédiats', 'expéditifs', 'accélérés', 'véloces'],


  // ═══════════════════════════════════════════════════════════════
  // LOCUTIONS (nécessitent reformulateText adapté au multi-mots)
  // ═══════════════════════════════════════════════════════════════

  // --- But / finalité ---
  'afin de': ['pour', 'en vue de', 'dans le but de', 'de façon à', 'de manière à', 'dans l\'objectif de'],
  'afin que': ['pour que', 'de sorte que', 'de manière que', 'de façon que'],
  'pour que': ['afin que', 'de sorte que', 'de manière que', 'de façon que'],
  'en vue de': ['afin de', 'pour', 'dans le but de', 'dans l\'objectif de', 'de manière à'],
  'dans le but de': ['afin de', 'en vue de', 'pour', 'dans l\'objectif de', 'de manière à'],
  'de façon à': ['afin de', 'de manière à', 'pour', 'en vue de'],
  'de manière à': ['afin de', 'de façon à', 'pour', 'en vue de'],

  // --- Cause / conséquence ---
  'en raison de': ['du fait de', 'suite à', 'compte tenu de', 'à cause de', 'en conséquence de'],
  'du fait de': ['en raison de', 'suite à', 'compte tenu de', 'à cause de'],
  'suite à': ['à la suite de', 'consécutivement à', 'après', 'en raison de', 'du fait de'],
  'à la suite de': ['suite à', 'consécutivement à', 'après', 'en raison de'],
  'compte tenu de': ['en raison de', 'du fait de', 'étant donné', 'eu égard à', 'vu'],
  'grâce à': ['au moyen de', 'par le biais de', 'par l\'intermédiaire de', 'via', 'moyennant'],
  'au moyen de': ['grâce à', 'par le biais de', 'via', 'par l\'intermédiaire de', 'moyennant'],
  'par le biais de': ['au moyen de', 'via', 'par l\'intermédiaire de', 'grâce à', 'moyennant'],
  'par conséquent': ['ainsi', 'dès lors', 'de ce fait', 'en conséquence', 'donc'],
  'de ce fait': ['ainsi', 'par conséquent', 'dès lors', 'en conséquence'],
  'dès lors': ['par conséquent', 'ainsi', 'de ce fait', 'en conséquence'],

  // --- Éventualité ---
  'en cas de': ['dans l\'éventualité de', 'lors de', 'advenant', 'si'],
  'pour toute': ['concernant toute', 'en cas de', 'relativement à toute', 'quant à toute'],
  'pour tout': ['concernant tout', 'relativement à tout', 'quant à tout', 'en cas de'],

  // --- À propos de ---
  'concernant': ['relatif à', 'au sujet de', 'à propos de', 'quant à', 'relativement à', 'touchant'],
  'au sujet de': ['concernant', 'à propos de', 'quant à', 'relativement à'],
  'à propos de': ['concernant', 'au sujet de', 'quant à', 'relativement à'],
  'relativement à': ['concernant', 'quant à', 'à propos de', 'au sujet de'],

  // --- Précision ---
  'notamment': ['en particulier', 'spécialement', 'précisément', 'entre autres', 'surtout'],
  'en particulier': ['notamment', 'spécifiquement', 'précisément', 'surtout', 'entre autres'],

  // --- Opposition ---
  'toutefois': ['cependant', 'néanmoins', 'pourtant', 'malgré tout'],
  'cependant': ['toutefois', 'néanmoins', 'pourtant', 'malgré tout'],
  'néanmoins': ['cependant', 'toutefois', 'pourtant', 'malgré tout'],
  'pourtant': ['cependant', 'toutefois', 'néanmoins', 'malgré tout'],

  // --- Ajout ---
  'de plus': ['en outre', 'également', 'par ailleurs', 'aussi', 'de surcroît'],
  'en outre': ['de plus', 'également', 'par ailleurs', 'aussi', 'de surcroît'],
  'par ailleurs': ['de plus', 'en outre', 'également', 'aussi', 'd\'autre part'],


  // ═══════════════════════════════════════════════════════════════
  // ADVERBES
  // ═══════════════════════════════════════════════════════════════

  // --- Rapidité ---
  'rapidement': ['vite', 'promptement', 'sans tarder', 'au plus vite', 'sans délai', 'immédiatement'],
  'vite': ['rapidement', 'promptement', 'sans délai', 'sans tarder', 'au plus vite'],
  'immédiatement': ['aussitôt', 'sur-le-champ', 'sans délai', 'instantanément', 'tout de suite'],
  'aussitôt': ['immédiatement', 'sur-le-champ', 'sans tarder', 'instantanément', 'tout de suite'],
  'promptement': ['rapidement', 'vite', 'sans tarder', 'sans délai', 'diligemment'],
  'progressivement': ['graduellement', 'peu à peu', 'par étapes', 'petit à petit'],
  'graduellement': ['progressivement', 'peu à peu', 'par degrés', 'petit à petit'],

  // --- Temporalité ---
  'actuellement': ['à présent', 'à ce jour', 'à l\'heure actuelle', 'aujourd\'hui', 'maintenant'],
  'maintenant': ['à présent', 'désormais', 'à l\'heure actuelle', 'actuellement', 'aujourd\'hui'],
  'désormais': ['dorénavant', 'dès à présent', 'à partir de maintenant', 'à l\'avenir'],
  'dorénavant': ['désormais', 'dès à présent', 'à partir de maintenant', 'à l\'avenir'],
  'auparavant': ['précédemment', 'antérieurement', 'avant', 'préalablement'],
  'précédemment': ['auparavant', 'antérieurement', 'avant', 'préalablement'],
  'ensuite': ['puis', 'par la suite', 'consécutivement', 'après', 'ultérieurement'],
  'puis': ['ensuite', 'par la suite', 'après'],
  'bientôt': ['prochainement', 'sous peu', 'd\'ici peu', 'incessamment'],
  'prochainement': ['bientôt', 'sous peu', 'd\'ici peu', 'incessamment'],
  'toujours': ['constamment', 'continuellement', 'en permanence', 'sans cesse', 'perpétuellement'],
  'souvent': ['fréquemment', 'régulièrement', 'habituellement', 'communément', 'ordinairement'],
  'parfois': ['quelquefois', 'occasionnellement', 'à l\'occasion', 'par moments', 'de temps à autre'],
  'rarement': ['peu souvent', 'exceptionnellement', 'occasionnellement', 'de temps à autre'],

  // --- Intensité ---
  'très': ['particulièrement', 'extrêmement', 'fort', 'grandement', 'hautement'],
  'extrêmement': ['très', 'particulièrement', 'infiniment', 'excessivement', 'grandement'],
  'particulièrement': ['spécialement', 'notamment', 'précisément', 'singulièrement', 'surtout'],
  'énormément': ['considérablement', 'grandement', 'excessivement', 'largement', 'beaucoup'],
  'beaucoup': ['grandement', 'considérablement', 'largement', 'énormément', 'amplement'],
  'complètement': ['totalement', 'entièrement', 'intégralement', 'absolument', 'pleinement'],
  'totalement': ['complètement', 'entièrement', 'intégralement', 'absolument', 'pleinement'],
  'entièrement': ['complètement', 'totalement', 'intégralement', 'absolument', 'pleinement'],
  'absolument': ['totalement', 'complètement', 'catégoriquement', 'formellement', 'entièrement'],
  'intégralement': ['complètement', 'totalement', 'entièrement', 'pleinement'],
  'pleinement': ['complètement', 'totalement', 'entièrement', 'intégralement'],

  // --- Manière ---
  'clairement': ['nettement', 'distinctement', 'précisément', 'manifestement'],
  'précisément': ['exactement', 'spécifiquement', 'clairement', 'nettement'],
  'exactement': ['précisément', 'rigoureusement', 'strictement', 'parfaitement'],
  'facilement': ['aisément', 'sans peine', 'simplement', 'commodément'],
  'aisément': ['facilement', 'sans peine', 'simplement', 'commodément'],
  'directement': ['sans intermédiaire', 'personnellement', 'immédiatement'],
  'automatiquement': ['systématiquement', 'spontanément', 'mécaniquement'],
  'systématiquement': ['automatiquement', 'invariablement', 'régulièrement', 'méthodiquement'],
  'gratuitement': ['sans frais', 'à titre gracieux', 'librement'],

  // --- Approximation ---
  'environ': ['approximativement', 'à peu près', 'aux alentours de', 'quelque', 'de l\'ordre de'],
  'approximativement': ['environ', 'à peu près', 'presque', 'aux alentours de'],
  'presque': ['quasiment', 'à peu près', 'pratiquement', 'quasi'],
  'quasiment': ['presque', 'pratiquement', 'quasi', 'à peu près']
};
// Fonction de reformulation avec synonymes (mono-mots + locutions)
function reformulateText(text) {
  if (!text) return text;

  // 1. Précalcul : sépare les clés multi-mots des mono-mots
  //    Les multi-mots sont triés par longueur décroissante pour éviter
  //    qu'une clé courte n'avale une clé plus longue (ex: "dans le" avant "dans le but de").
  const multiWordKeys = Object.keys(SYNONYMS)
    .filter(k => k.includes(' '))
    .sort((a, b) => b.length - a.length);

  let reformulated = text;

  // 2. Remplacement des locutions multi-mots.
  //    On utilise une regex insensible à la casse avec limites de mot,
  //    et on garde la casse d'origine (minuscule/majuscule initiale).
  for (const key of multiWordKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    reformulated = reformulated.replace(regex, (match) => {
      if (Math.random() >= 0.5) return match; // pas de remplacement cette fois
      const synonyms = SYNONYMS[key];
      const chosen = synonyms[Math.floor(Math.random() * synonyms.length)];
      // Respecte la casse initiale : si le mot d'origine commençait par une majuscule, on capitalise
      if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
        return chosen.charAt(0).toUpperCase() + chosen.slice(1);
      }
      return chosen;
    });
  }

  // 3. Traitement mot-par-mot (inchangé, sauf qu'il opère sur le texte déjà transformé)
  const sentences = reformulated.split(/([.!?]+\s*)/);
  const newSentences = sentences.map(sentence => {
    const words = sentence.split(/\s+/);
    const newWords = words.map(word => {
      const clean = word.replace(/[.,!?;:()"]/g, '');
      const punct = word.match(/[.,!?;:()"]/g) || [];

      if (clean in SYNONYMS && Math.random() < 0.5) {
        const synonyms = SYNONYMS[clean];
        const chosen = synonyms[Math.floor(Math.random() * synonyms.length)];
        return chosen + punct.join('');
      }
      return word;
    });
    return newWords.join(' ');
  });

  return newSentences.join('');
}

// ─────────────────────────────────────────────────────
// TEMPLATES HTML (10 modèles différents)
// ─────────────────────────────────────────────────────
const TEMPLATES = [
  {
    id: 'template1',
    name: 'Style Classique Banque/Assurance',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #f0f2f5;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 580px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 30px 30px 15px; BACKGROUND-COLOR: [PRIMARY_COLOR]; border-radius: 6px 6px 0 0;">
                                <p style="MARGIN: 0; text-align: center;">
                                    <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 120px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #666666; MARGIN: 0 0 12px; TEXT-TRANSFORM: uppercase; LETTER-SPACING: 1px;"></p>
                                <h2 style="FONT-SIZE: 20px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #1a1a2e; MARGIN: 0 0 12px; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 15px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #333333; MARGIN: 0 0 12px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 15px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #333333; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #f8f9fa; PADDING: 14px 18px; border-radius: 4px; MARGIN: 0 0 16px; border-left: 3px solid [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 0; LINE-HEIGHT: 1.5;"><strong>📌 Référence :</strong> [REFERENCE_DOSSIER]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]">🔐 Accéder à mon compte</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0 0 8px; LINE-HEIGHT: 1.4; FONT-STYLE: italic;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 15px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #333333; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]</p>
                                <p style="FONT-SIZE: 15px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #333333; MARGIN: 0 0 4px; LINE-HEIGHT: 1.5;">Cordialement,<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e0e0e0 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #999999; MARGIN: 0; LINE-HEIGHT: 1.4; TEXT-ALIGN: center;">
                                    <a style="COLOR: #999999; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template2',
    name: 'Style Minimaliste / Moderne',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #fafafa;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 560px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 0; box-shadow: none; BORDER: 1px solid #e8e8e8;" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 30px 30px 20px; BORDER-BOTTOM: 2px solid [PRIMARY_COLOR]; TEXT-ALIGN: center;">
                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 120px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <span style="FONT-SIZE: 36px;"></span>
                                </div>
                                <h2 style="FONT-SIZE: 18px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #2c3e50; MARGIN: 0 0 12px; TEXT-ALIGN: center; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 0 0 10px; TEXT-ALIGN: center; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 0 0 12px; LINE-HEIGHT: 1.7;">[TEXTE_CONTENU]</p>
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px; PADDING: 12px; BACKGROUND-COLOR: #f8f9fa; border-radius: 4px;">
                                    <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LETTER-SPACING: 0.5px;">⏰ [DATE_ACTION]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 40px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 4px; LETTER-SPACING: 0.5px;" href="[LIEN_CTA]">Se connecter →</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #999999; TEXT-ALIGN: center; MARGIN: 0; LINE-HEIGHT: 1.4;">[NOTE_SECURITE]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 15px 30px; BACKGROUND-COLOR: #f8f9fa;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    [MENTIONS_LEGALES] &nbsp;·&nbsp; <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a>
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template3',
    name: 'Style avec Bandeau Couleur',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #eef2f7;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 600px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 0; BACKGROUND-COLOR: [PRIMARY_COLOR]; border-radius: 10px 10px 0 0;">
                                <p style="MARGIN: 0; PADDING: 18px 30px; text-align: center;">
                                    <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <h2 style="FONT-SIZE: 19px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #2c3e50; MARGIN: 0 0 10px; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #fef9f7; PADDING: 12px 16px; border-radius: 4px; MARGIN: 0 0 16px; BORDER: 1px solid [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0; LINE-HEIGHT: 1.4;"> [MESSAGE_ACTION]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 36px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]"> Accéder à mon espace</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0 0 8px; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e8e8e8 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template4',
    name: 'Style avec Icônes / Cards',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #f5f6fa;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 600px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 25px 30px 15px; TEXT-ALIGN: center;">
                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 120px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 20px;">
                                <div style="DISPLAY: flex; gap: 10px; MARGIN: 0 0 16px; flex-wrap: wrap;">
                                    <div style="FLEX: 1; BACKGROUND-COLOR: #e8f4fd; PADDING: 12px; TEXT-ALIGN: center; border-radius: 6px; MIN-WIDTH: 80px; border: 1px solid [PRIMARY_COLOR];">
                                        <p style="FONT-SIZE: 20px; MARGIN: 0;">🔐</p>
                                        <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 4px 0 0;">Sécurisé</p>
                                    </div>
                                    <div style="FLEX: 1; BACKGROUND-COLOR: #fef9e7; PADDING: 12px; TEXT-ALIGN: center; border-radius: 6px; MIN-WIDTH: 80px; border: 1px solid [PRIMARY_COLOR];">
                                        <p style="FONT-SIZE: 20px; MARGIN: 0;">📌</p>
                                        <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 4px 0 0;">Important</p>
                                    </div>
                                </div>
                                <h2 style="FONT-SIZE: 18px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #1a1a2e; MARGIN: 0 0 10px; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 25px;" href="[LIEN_CTA]"> Je me connecte</a>
                                </p>
                                <p style="FONT-SIZE: 12px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #999999; TEXT-ALIGN: center; MARGIN: 0; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 15px 30px; BACKGROUND-COLOR: #f8f9fa; border-radius: 0 0 12px 12px;">
                                <p style="FONT-SIZE: 10px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #bbbbbb; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    [MENTIONS_LEGALES] &nbsp;·&nbsp; <a style="COLOR: #bbbbbb; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a>
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template5',
    name: 'Style avec Encadré Bleu',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #e8ecf1;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 600px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: 3px solid [PRIMARY_COLOR];" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 25px 30px 15px; BACKGROUND-COLOR: [PRIMARY_COLOR];">
                                <p style="MARGIN: 0; text-align: center;">
                                    <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <div style="BACKGROUND-COLOR: #ebf5fb; PADDING: 14px 18px; border-radius: 4px; MARGIN: 0 0 16px; border-left: 4px solid [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0; FONT-WEIGHT: 600;"></p>
                                </div>
                                <h2 style="FONT-SIZE: 19px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #1a1a2e; MARGIN: 0 0 10px; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #f8f9fa; PADDING: 12px 16px; border-radius: 4px; MARGIN: 0 0 16px; TEXT-ALIGN: center;">
                                    <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0; FONT-WEIGHT: 700;">Référence : [REFERENCE_DOSSIER]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 36px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]">Consulter maintenant</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e0e0e0 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template6',
    name: 'Style Vert / Confiance',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #f0f7f0;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 580px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 0 30px; BACKGROUND-COLOR: [PRIMARY_COLOR]; border-radius: 8px 8px 0 0;">
                                <p style="MARGIN: 0; PADDING: 16px 0; text-align: center;">
                                    <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <span style="FONT-SIZE: 40px;"></span>
                                </div>
                                <h2 style="FONT-SIZE: 19px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #1a1a2e; MARGIN: 0 0 10px; TEXT-ALIGN: center; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]">Confirmer et accéder</a>
                                </p>
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <p style="FONT-SIZE: 12px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LINE-HEIGHT: 1.4;">⏰ [DATE_ACTION]</p>
                                </div>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e0e0e0 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template7',
    name: 'Style avec Barre Latérale',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #f4f6f9;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 600px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.04);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <table style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0;">
                                    <tbody>
                                        <tr>
                                            <td style="WIDTH: 6px; BACKGROUND-COLOR: [PRIMARY_COLOR]; border-radius: 4px 0 0 4px; PADDING: 0;"></td>
                                            <td style="PADDING: 0 0 0 20px;">
                                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                                <h2 style="FONT-SIZE: 18px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #2c3e50; MARGIN: 10px 0 10px; LINE-HEIGHT: 1.3;"></h2>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #f4ecf7; PADDING: 12px 16px; border-radius: 4px; MARGIN: 0 0 16px; BORDER: 1px solid [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0; LINE-HEIGHT: 1.4;"> [NOTE_SECURITE]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]"> Me connecter</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e8e8e8 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template8',
    name: 'Style Orange / Urgence',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #fdf6ec;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 580px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 0; BACKGROUND-COLOR: [PRIMARY_COLOR]; border-radius: 10px 10px 0 0;">
                                <table style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0;">
                                    <tbody>
                                        <tr>
                                            <td style="PADDING: 12px 20px;">
                                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 80px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                            </td>
                                            <td style="PADDING: 12px 20px; TEXT-ALIGN: right;">
                                                <span style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #ffffff; BACKGROUND-COLOR: rgba(255,255,255,0.2); PADDING: 2px 10px; border-radius: 12px;">URGENT</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <h2 style="FONT-SIZE: 19px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0 0 10px; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #fdebd0; PADDING: 12px 16px; border-radius: 4px; MARGIN: 0 0 16px; BORDER: 1px solid [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: [PRIMARY_COLOR]; MARGIN: 0; LINE-HEIGHT: 1.4;">[MESSAGE_ACTION]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px;" href="[LIEN_CTA]"> Agir maintenant</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e8e8e8 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template9',
    name: 'Style Gris / Élégant',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #eaeef3;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 560px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 8px; box-shadow: 0 3px 10px rgba(0,0,0,0.04);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 30px 30px 15px; TEXT-ALIGN: center; BORDER-BOTTOM: 1px solid #e8e8e8;">
                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 25px 30px 20px;">
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <span style="FONT-SIZE: 32px;">📄</span>
                                </div>
                                <h2 style="FONT-SIZE: 18px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #2c3e50; MARGIN: 0 0 10px; TEXT-ALIGN: center; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 0 0 10px; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="BACKGROUND-COLOR: #f8f9fa; PADDING: 10px 16px; border-radius: 4px; MARGIN: 0 0 16px; TEXT-ALIGN: center; BORDER: 1px dashed [PRIMARY_COLOR];">
                                    <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #7f8c8d; MARGIN: 0;">📎 [REFERENCE_DOSSIER]</p>
                                </div>
                                <p style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 34px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 4px;" href="[LIEN_CTA]"> Accéder à l'espace client</a>
                                </p>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #555555; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 15px 30px; BACKGROUND-COLOR: #f8f9fa; border-radius: 0 0 8px 8px;">
                                <p style="FONT-SIZE: 10px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #bbbbbb; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    [MENTIONS_LEGALES] &nbsp;·&nbsp; <a style="COLOR: #bbbbbb; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a>
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  },
  {
    id: 'template10',
    name: 'Style avec Double Bouton',
    html: `<table class="body" style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #f0f2f5;">
    <tbody>
        <tr>
            <td style="PADDING: 20px 0;" valign="top" align="left">
                <table class="container" style="MAX-WIDTH: 600px; WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0; BACKGROUND-COLOR: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);" align="center">
                    <tbody>
                        <tr>
                            <td style="PADDING: 25px 30px 15px;">
                                <table style="WIDTH: 100%; BORDER-COLLAPSE: collapse; BORDER-SPACING: 0;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <img style="COLOR: #e6e6e6; BACKGROUND-COLOR: #e6e6e6; MAX-WIDTH: 100px;" src="[LOGO_URL]" alt="[NOM_ENTREPRISE]">
                                            </td>
                                            <td style="TEXT-ALIGN: right;">
                                                <span style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #ffffff; BACKGROUND-COLOR: [PRIMARY_COLOR]; PADDING: 2px 12px; border-radius: 4px;"></span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 20px;">
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <span style="FONT-SIZE: 38px;">📬</span>
                                </div>
                                <h2 style="FONT-SIZE: 18px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #1a1a2e; MARGIN: 0 0 10px; TEXT-ALIGN: center; LINE-HEIGHT: 1.3;"></h2>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 10px; TEXT-ALIGN: center; LINE-HEIGHT: 1.6;">[TEXTE_INTRO]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 0 0 16px; LINE-HEIGHT: 1.6;">[TEXTE_CONTENU]</p>
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <a style="FONT-SIZE: 15px; TEXT-DECORATION: none; FONT-FAMILY: Arial,Helvetica,sans-serif; FONT-WEIGHT: 600; COLOR: #ffffff; PADDING: 12px 36px; DISPLAY: inline-block; BACKGROUND-COLOR: [BUTTON_COLOR]; border-radius: 6px; MARGIN: 0 0 8px;" href="[LIEN_CTA]">Je me connecte</a>
                                </div>
                                <div style="TEXT-ALIGN: center; MARGIN: 0 0 16px;">
                                    <p style="FONT-SIZE: 12px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #999999; MARGIN: 0; LINE-HEIGHT: 1.4;">
                                    </p>
                                </div>
                                <p style="FONT-SIZE: 13px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #888888; MARGIN: 0; LINE-HEIGHT: 1.4;">[DATE_ACTION]</p>
                                <p style="FONT-SIZE: 14px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #444444; MARGIN: 16px 0 4px; LINE-HEIGHT: 1.5;">[TEXTE_CONCLUSION]<br><strong>[NOM_ENTREPRISE]</strong></p>
                            </td>
                        </tr>
                        <tr>
                            <td style="PADDING: 0 30px 15px;">
                                <hr style="BORDER-TOP: #e0e0e0 1px solid; BORDER-RIGHT: 0; BORDER-BOTTOM: 0; BORDER-LEFT: 0; MARGIN: 0 0 10px;">
                                <p style="FONT-SIZE: 11px; FONT-FAMILY: Arial,Helvetica,sans-serif; COLOR: #aaaaaa; MARGIN: 0; TEXT-ALIGN: center; LINE-HEIGHT: 1.4;">
                                    <a style="COLOR: #aaaaaa; TEXT-DECORATION: underline;" href="[LIEN_DESABONNEMENT]">Se désabonner</a> &nbsp;·&nbsp; [MENTIONS_LEGALES]
                                </p>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>`
  }
];

// ─────────────────────────────────────────────────────
// FONCTION DE GÉNÉRATION D'EMAIL AVEC TEMPLATE
// ─────────────────────────────────────────────────────
function generateEmailFromTemplate(template, config, baseText, clientName, link, unsubLink, mentions) {
  // 1. Reformulation du texte
  const reformulatedText = reformulateText(baseText);
  
  // 2. Préparer les variables
  const dateAction = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const refDossier = 'REF-' + Date.now().toString(36).toUpperCase();
  const messageAction = 'Veuillez procéder à cette mise à jour dans les plus brefs délais.';
  
  // 3. Remplacer toutes les balises
  let html = template.html
    .replace(/\[NOM_ENTREPRISE\]/g, config.companyName || 'DEVICO')
    .replace(/\[PRENOM_CLIENT\]/g, clientName || 'Client')
    .replace(/\[LIEN_CTA\]/g, link || config.ctaUrl || '#')
    .replace(/\[LIEN_DESABONNEMENT\]/g, unsubLink || '#')
    .replace(/\[DATE_ACTION\]/g, dateAction)
    .replace(/\[MENTIONS_LEGALES\]/g, mentions || config.mentionsLegales || 'Mentions légales de l\'entreprise')
    .replace(/\[TEXTE_INTRO\]/g, 'Madame, Monsieur,')
    .replace(/\[TEXTE_CONTENU\]/g, reformulatedText)
    .replace(/\[TEXTE_CONCLUSION\]/g, 'Pour toute question, notre équipe d\'assistance est à votre disposition via notre site officiel ou par e-mail au support')
    .replace(/\[LOGO_URL\]/g, config.logoUrl || '')
    .replace(/\[PRIMARY_COLOR\]/g, config.primaryColor || '#003da5')
    .replace(/\[BUTTON_COLOR\]/g, config.buttonColor || '#003da5')
    .replace(/\[REFERENCE_DOSSIER\]/g, refDossier)
    .replace(/\[NOTE_SECURITE\]/g, 'Ce message est sécurisé et ne nécessite aucune réponse par e-mail.')
    .replace(/\[MESSAGE_ACTION\]/g, messageAction)
    .replace(/\[LIEN_ALTERNATIF\]/g, link || config.ctaUrl || '#');
  
  return {
    html: html,
    subject: '🔐 Mise à jour de vos informations personnelles - ' + config.companyName,
    text: reformulatedText,
    reformulatedText: reformulatedText
  };
}

// ─────────────────────────────────────────────────────
// OBFUSCATION — Version préservant la lisibilité et les liens
// ─────────────────────────────────────────────────────

// Configuration des modes d'obfuscation
const OBFUSCATION_MODES = {
  light: { homoglyph_rate: 0.08, invisible_rate: 0.005 },
  medium: { homoglyph_rate: 0.15, invisible_rate: 0.01 },
  aggressive: { homoglyph_rate: 0.25, invisible_rate: 0.02 }
};

// Homoglyphes visuels
const HOMOGLYPHS = {
  'a': ['а'], 'c': ['с'], 'e': ['е'], 'o': ['о'], 'p': ['р'],
  'x': ['х'], 'y': ['у'], 's': ['ѕ'], 'h': ['һ'], 'k': ['κ'],
  't': ['τ'], 'i': ['і'], 'm': ['м'], 'b': ['Ь']
};

const INVISIBLES = ['\u200B', '\u200C'];

const SKIP_PATTERNS = [
  /https?:\/\//i, /www\.[a-zA-Z0-9\-\.]+/i, /@[A-Za-z0-9\-\.]+/,
  /\d{2,}/, /\.com\b/i, /\.fr\b/i, /\.net\b/i, /\.org\b/i,
  /\.io\b/i, /\.eu\b/i, /\.co\b/i, /\.uk\b/i, /\.de\b/i,
  /\.it\b/i, /\.es\b/i, /\.nl\b/i, /\.be\b/i, /\.ch\b/i,
  /\/[a-zA-Z0-9\/\-_\.]+/, /^\//, /^#/, /\?[a-zA-Z0-9=&\-_]+/,
  /&[a-zA-Z0-9]+;/, /#[a-zA-Z0-9]+/, /:\/\/[a-zA-Z0-9\-\.]+/
];

function isUrlOrDomain(text) {
  if (/^https?:\/\//i.test(text)) return true;
  if (/^www\.[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}/i.test(text)) return true;
  if (/^[a-zA-Z0-9\-]+\.[a-zA-Z]{2,}(?:\/|$)/i.test(text)) return true;
  return false;
}

function shouldSkipWord(word) {
  if (isUrlOrDomain(word)) return true;
  if (SKIP_PATTERNS.some(p => p.test(word))) return true;
  if (word.length <= 2) return true;
  return false;
}

function isAccented(char) {
  const accents = 'àâäæáãåāèéêëęēîïíīìôöòóøōùûüúūÿýŷçćčñń';
  return accents.includes(char.toLowerCase());
}

function shouldPreserveWord(word) {
  for (const char of word) {
    if (isAccented(char)) return true;
  }
  return false;
}

function obfuscateWord(word, homoglyphRate, invisibleRate) {
  if (shouldPreserveWord(word) || word.length <= 2) {
    return word;
  }
  
  const result = [];
  let hasModification = false;
  
  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    const lower = char.toLowerCase();
    
    if (!/[a-zA-Z]/.test(char)) {
      result.push(char);
      continue;
    }
    
    if (isAccented(char)) {
      result.push(char);
      continue;
    }
    
    if (lower in HOMOGLYPHS && Math.random() < homoglyphRate) {
      const replacements = HOMOGLYPHS[lower];
      let replacement = replacements[Math.floor(Math.random() * replacements.length)];
      if (char !== lower) replacement = replacement.toUpperCase();
      result.push(replacement);
      hasModification = true;
    } else {
      result.push(char);
    }
    
    if (/[a-zA-Z]/.test(char) && Math.random() < invisibleRate) {
      if (result.length > 1 && /[a-zA-Z]/.test(result[result.length - 2])) {
        result.push(INVISIBLES[Math.floor(Math.random() * INVISIBLES.length)]);
        hasModification = true;
      }
    }
  }
  
  return hasModification ? result.join('') : word;
}

function obfuscateText(text, mode = 'medium') {
  if (!text || !text.trim()) return text;
  
  const config = OBFUSCATION_MODES[mode] || OBFUSCATION_MODES.medium;
  const { homoglyph_rate, invisible_rate } = config;
  
  const lines = text.split('\n');
  const processedLines = lines.map(line => {
    const words = line.split(/(\s+)/);
    const processed = words.map(word => {
      if (/^\s+$/.test(word)) return word;
      if (/^[.,!?;:()"']+$/.test(word)) return word;
      if (isUrlOrDomain(word)) return word;
      if (word === word.toUpperCase() && word.length > 2) return word;
      if (shouldSkipWord(word)) return word;
      return obfuscateWord(word, homoglyph_rate, invisible_rate);
    });
    return processed.join('');
  });
  
  return processedLines.join('\n');
}

function obfuscateHtmlContent(html, mode = 'medium', seed = null) {
  if (!html || !html.trim()) return html;
  
  const config = OBFUSCATION_MODES[mode] || OBFUSCATION_MODES.medium;
  const { homoglyph_rate, invisible_rate } = config;
  
  let rng = Math.random;
  if (seed !== null) {
    let s = seed;
    rng = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }
  
  let result = '';
  let i = 0;
  let inTag = false;
  let inLink = false;
  let tagContent = '';
  let textBuffer = '';
  let preserveText = false;
  
  const flushText = () => {
    if (textBuffer.trim() && !preserveText && !inLink) {
      const lines = textBuffer.split('\n');
      const processedLines = lines.map(line => {
        const words = line.split(/(\s+)/);
        const processed = words.map(word => {
          if (/^\s+$/.test(word)) return word;
          if (/^[.,!?;:()"']+$/.test(word)) return word;
          if (isUrlOrDomain(word)) return word;
          if (shouldSkipWord(word)) return word;
          const obfWord = (w) => {
            const result = [];
            let hasModification = false;
            for (const char of w) {
              const lower = char.toLowerCase();
              if (!/[a-zA-Z]/.test(char) || isAccented(char)) {
                result.push(char);
                continue;
              }
              if (lower in HOMOGLYPHS && rng() < config.homoglyph_rate) {
                const replacements = HOMOGLYPHS[lower];
                let replacement = replacements[Math.floor(rng() * replacements.length)];
                if (char !== lower) replacement = replacement.toUpperCase();
                result.push(replacement);
                hasModification = true;
              } else {
                result.push(char);
              }
              if (/[a-zA-Z]/.test(char) && rng() < config.invisible_rate) {
                if (result.length > 1 && /[a-zA-Z]/.test(result[result.length - 2])) {
                  result.push(INVISIBLES[Math.floor(rng() * INVISIBLES.length)]);
                  hasModification = true;
                }
              }
            }
            return hasModification ? result.join('') : w;
          };
          return obfWord(word);
        });
        return processed.join('');
      });
      result += processedLines.join('\n');
    } else {
      result += textBuffer;
    }
    textBuffer = '';
    preserveText = false;
  };
  
  while (i < html.length) {
    const char = html[i];
    
    if (char === '<' && !inTag) {
      flushText();
      inTag = true;
      tagContent = '';
      result += char;
    } else if (char === '>' && inTag) {
      inTag = false;
      tagContent += char;
      
      const tagMatch = tagContent.match(/^\/?([a-zA-Z0-9]+)/);
      const tagName = tagMatch ? tagMatch[1].toLowerCase() : '';
      const isClosingTag = tagContent.startsWith('/');
      
      if (tagName === 'a' && !isClosingTag) {
        inLink = true;
      } else if (tagName === 'a' && isClosingTag) {
        inLink = false;
      }
      
      if (['code', 'pre', 'script', 'style', 'textarea'].includes(tagName) && !isClosingTag) {
        preserveText = true;
      }
      if (['code', 'pre', 'script', 'style', 'textarea'].includes(tagName) && isClosingTag) {
        preserveText = false;
      }
      
      result += tagContent;
      tagContent = '';
    } else if (inTag) {
      tagContent += char;
    } else {
      textBuffer += char;
    }
    i++;
  }
  
  flushText();
  return result;
}

// ─────────────────────────────────────────────────────
// AUTH — gate par code d'accès
// ─────────────────────────────────────────────────────
function newToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function tokenValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokenValid(token)) {
    return res.status(401).json({ success: false, error: 'Non autorisé — code d\'accès requis' });
  }
  next();
}

// ─────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  if (!code) return res.json({ success: false, error: 'Code requis' });
  if (code !== ACCESS_CODE) return res.json({ success: false, error: 'Code invalide' });
  res.json({ success: true, token: newToken() });
});

app.get('/api/auth/check', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  res.json({ success: true, valid: tokenValid(token) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sessions.delete(token);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────
// CONFIGURATION ROUTES
// ─────────────────────────────────────────────────────
app.post('/api/config', requireAuth, (req, res) => {
  const { companyName, logoUrl, primaryColor, ctaUrl, mentionsLegales } = req.body;
  
  if (companyName) userConfig.companyName = companyName;
  if (logoUrl) userConfig.logoUrl = logoUrl;
  if (ctaUrl) userConfig.ctaUrl = ctaUrl;
  if (mentionsLegales) userConfig.mentionsLegales = mentionsLegales;
  if (primaryColor) {
    if (/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      userConfig.primaryColor = primaryColor;
      userConfig.buttonColor = primaryColor;
    }
  }
  
  // Sauvegarder dans le fichier
  saveConfigToFile(userConfig);
  
  res.json({ success: true, config: userConfig });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({ success: true, config: userConfig });
});

// ─────────────────────────────────────────────────────
// EXPORT / IMPORT DE CONFIGURATION (JSON)
// ─────────────────────────────────────────────────────
app.get('/api/config/export', requireAuth, (req, res) => {
  try {
    const config = {
      companyName: userConfig.companyName,
      logoUrl: userConfig.logoUrl,
      primaryColor: userConfig.primaryColor,
      ctaUrl: userConfig.ctaUrl,
      mentionsLegales: userConfig.mentionsLegales,
      exportedAt: new Date().toISOString()
    };
    res.json({ success: true, config });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/config/import', requireAuth, (req, res) => {
  try {
    const config = req.body;
    if (!config) {
      return res.json({ success: false, error: 'Configuration manquante' });
    }
    
    if (config.companyName) userConfig.companyName = config.companyName;
    if (config.logoUrl) userConfig.logoUrl = config.logoUrl;
    if (config.ctaUrl) userConfig.ctaUrl = config.ctaUrl;
    if (config.mentionsLegales) userConfig.mentionsLegales = config.mentionsLegales;
    if (config.primaryColor && /^#[0-9a-fA-F]{6}$/.test(config.primaryColor)) {
      userConfig.primaryColor = config.primaryColor;
      userConfig.buttonColor = config.primaryColor;
    }
    
    // Sauvegarder dans le fichier
    saveConfigToFile(userConfig);
    
    res.json({ success: true, config: userConfig });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// TEMPLATES ROUTES
// ─────────────────────────────────────────────────────
app.get('/api/templates', requireAuth, (req, res) => {
  res.json({ success: true, templates: TEMPLATES.map(t => ({ id: t.id, name: t.name })) });
});

// ─────────────────────────────────────────────────────
// PREVIEW ROUTE
// ─────────────────────────────────────────────────────
app.post('/api/template/preview', requireAuth, (req, res) => {
  try {
    const { templateId, text, clientName, link } = req.body;
    const template = TEMPLATES.find(t => t.id === templateId);
    
    if (!template) {
      return res.json({ success: false, error: 'Template non trouvé' });
    }
    
    const result = generateEmailFromTemplate(
      template,
      userConfig,
      text || 'Nous avons détecté un problème avec les informations associées à votre compte. Afin de garantir un accès sécurisé et fluide à nos services d\'identification numérique, il est impératif de mettre à jour vos données personnelles dans les plus brefs délais.',
      clientName || 'Client',
      link || userConfig.ctaUrl || '#',
      '#',
      userConfig.mentionsLegales || 'Mentions légales'
    );
    
    res.json({ success: true, preview: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// HELPERS D'ENVOI
// ─────────────────────────────────────────────────────
const asArray = x => Array.isArray(x) ? x : (x ? [x] : []);

const API_PROVIDERS = {
  resend: {
    label: 'Resend',
    endpoint: 'https://api.resend.com/emails',
    headers: k => ({ 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: m => {
      const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
      const p = { from, to: asArray(m.to), subject: m.subject };
      if (m.cc && m.cc.length)   p.cc = m.cc;
      if (m.bcc && m.bcc.length) p.bcc = m.bcc;
      if (m.replyTo)             p.reply_to = m.replyTo;
      if (m.html) p.html = m.html; else p.text = m.text || '';
      if (m.attachments && m.attachments.length)
        p.attachments = m.attachments.map(a => ({ filename: a.filename, content: a.content }));
      return p;
    },
    error: (res, d) => d?.message || d?.error || `HTTP ${res.status}`
  },
  postmark: {
    label: 'Postmark',
    endpoint: 'https://api.postmarkapp.com/email',
    headers: k => ({ 'X-Postmark-Server-Token': k, 'Content-Type': 'application/json', 'Accept': 'application/json' }),
    body: m => {
      const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
      const p = { From: from, To: asArray(m.to).join(','), Subject: m.subject, MessageStream: 'outbound' };
      if (m.cc && m.cc.length)   p.Cc = m.cc.join(',');
      if (m.bcc && m.bcc.length) p.Bcc = m.bcc.join(',');
      if (m.replyTo)             p.ReplyTo = m.replyTo;
      if (m.html) p.HtmlBody = m.html; else p.TextBody = m.text || '';
      if (m.attachments && m.attachments.length)
        p.Attachments = m.attachments.map(a => ({ Name: a.filename, Content: a.content, ContentType: a.type || 'application/octet-stream' }));
      return p;
    },
    error: (res, d) => d?.Message || `HTTP ${res.status}`
  },
  brevo: {
    label: 'Brevo',
    endpoint: 'https://api.brevo.com/v3/smtp/email',
    headers: k => ({ 'api-key': k, 'Content-Type': 'application/json', 'Accept': 'application/json' }),
    body: m => {
      const p = {
        sender: m.fromName ? { name: m.fromName, email: m.fromEmail } : { email: m.fromEmail },
        to: asArray(m.to).map(e => ({ email: e })),
        subject: m.subject
      };
      if (m.cc && m.cc.length)   p.cc = m.cc.map(e => ({ email: e }));
      if (m.bcc && m.bcc.length) p.bcc = m.bcc.map(e => ({ email: e }));
      if (m.replyTo)             p.replyTo = { email: m.replyTo };
      if (m.html) p.htmlContent = m.html; else p.textContent = m.text || '';
      if (m.attachments && m.attachments.length)
        p.attachment = m.attachments.map(a => ({ name: a.filename, content: a.content }));
      return p;
    },
    error: (res, d) => d?.message || `HTTP ${res.status}`
  },
  mailersend: {
    label: 'MailerSend',
    endpoint: 'https://api.mailersend.com/v1/email',
    headers: k => ({ 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
    body: m => {
      const p = {
        from: m.fromName ? { email: m.fromEmail, name: m.fromName } : { email: m.fromEmail },
        to: asArray(m.to).map(e => ({ email: e })),
        subject: m.subject
      };
      if (m.cc && m.cc.length)   p.cc = m.cc.map(e => ({ email: e }));
      if (m.bcc && m.bcc.length) p.bcc = m.bcc.map(e => ({ email: e }));
      if (m.replyTo)             p.reply_to = { email: m.replyTo };
      if (m.html) p.html = m.html; else p.text = m.text || '';
      if (m.attachments && m.attachments.length)
        p.attachments = m.attachments.map(a => ({ filename: a.filename, content: a.content, disposition: 'attachment' }));
      return p;
    },
    error: (res, d) => d?.message || `HTTP ${res.status}`
  },
  maileroo: {
    label: 'Maileroo',
    endpoint: 'https://smtp.maileroo.com/api/v2/emails',
    headers: k => ({ 'X-API-Key': k, 'Content-Type': 'application/json' }),
    body: m => {
      const p = {
        from: m.fromName ? { address: m.fromEmail, display_name: m.fromName } : { address: m.fromEmail },
        to: asArray(m.to).map(e => ({ address: e })),
        subject: m.subject
      };
      if (m.cc && m.cc.length)   p.cc = m.cc.map(e => ({ address: e }));
      if (m.bcc && m.bcc.length) p.bcc = m.bcc.map(e => ({ address: e }));
      if (m.replyTo)             p.reply_to = { address: m.replyTo };
      if (m.html) p.html = m.html; else p.plain = m.text || '';
      if (m.attachments && m.attachments.length)
        p.attachments = m.attachments.map(a => ({ file_name: a.filename, content: a.content, content_type: a.type || 'application/octet-stream' }));
      return p;
    },
    error: (res, d) => d?.message || `HTTP ${res.status}`
  },
  nuntly: {
    label: 'Nuntly',
    endpoint: 'https://api.nuntly.com/emails',
    headers: k => ({ 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: m => {
      const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
      const p = { from, to: asArray(m.to), subject: m.subject };
      if (m.cc && m.cc.length)   p.cc = m.cc;
      if (m.bcc && m.bcc.length) p.bcc = m.bcc;
      if (m.replyTo)             p.replyTo = m.replyTo;
      if (m.html) p.html = m.html; else p.text = m.text || '';
      if (m.attachments && m.attachments.length)
        p.attachments = m.attachments.map(a => ({ content: a.content, filename: a.filename, contentType: a.type || 'application/octet-stream' }));
      return p;
    },
    error: (res, d) => (d && d.error && d.error.title) || d?.message || `HTTP ${res.status}`
  }
};

async function sendViaApi(providerKey, m) {
  const P = API_PROVIDERS[providerKey] || API_PROVIDERS.resend;
  if (!m.apiKey)   throw new Error('Clé API manquante');
  if (!m.fromEmail) throw new Error('From Email manquant (domaine vérifié)');

  const res = await fetch(P.endpoint, {
    method: 'POST',
    headers: P.headers(m.apiKey),
    body: JSON.stringify(P.body(m))
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(`[${P.label}] ${P.error(res, data)}`);
  return data;
}

function buildSmtpTransporter(smtp, pool = false) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: parseInt(smtp.port),
    secure: smtp.secure === true,
    auth: { user: smtp.user, pass: smtp.pass },
    pool,
    maxConnections: pool ? 1 : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function smtpAttachments(attachments) {
  if (!attachments || !attachments.length) return undefined;
  return attachments.map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
    contentType: a.type || undefined
  }));
}

// ─────────────────────────────────────────────────────
// AIDE À LA DÉLIVRABILITÉ
// ─────────────────────────────────────────────────────

function emailDomain(addr) {
  const m = String(addr || '').match(/@([^>]+)/);
  return m ? m[1].replace(/[>\s].*$/, '').toLowerCase() : 'localhost';
}

function makeMessageId(fromEmail) {
  const dom = emailDomain(fromEmail);
  const rnd = Math.random().toString(36).slice(2, 10);
  const ts  = Date.now().toString(36);
  return `<${ts}.${rnd}@${dom}>`;
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function deliverabilityHeaders(fromEmail) {
  const domain = emailDomain(fromEmail);
  const unsubEmail = `unsubscribe@${domain}`;
  const messageId = makeMessageId(fromEmail);
  
  return {
    'List-Unsubscribe': `<mailto:${unsubEmail}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Precedence': 'bulk',
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    'X-Mailer': 'YODA MAILER V5',
    'X-Priority': '3',
    'X-MSMail-Priority': 'Normal',
    'X-Report-Abuse': `mailto:abuse@${domain}?subject=Report%20Abuse`,
    'Return-Path': `<${fromEmail}>`,
    'X-Entity-ID': `yoda-mailer-${Date.now().toString(36)}`,
    'Feedback-ID': `campaign:${Date.now().toString(36)}:yoda`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Message-ID': messageId
  };
}

async function sendViaSmtp(transporter, opts) {
  const { fromEmail, fromName, to, cc, bcc, replyTo, subject, text, html, attachments } = opts;

  const finalText = html ? (text || htmlToText(html)) : (text || '');

  return transporter.sendMail({
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to,
    cc: cc && cc.length ? cc : undefined,
    bcc: bcc && bcc.length ? bcc : undefined,
    replyTo: replyTo || undefined,
    subject,
    text: finalText || undefined,
    html: html || undefined,
    attachments: smtpAttachments(attachments),
    messageId: makeMessageId(fromEmail),
    headers: deliverabilityHeaders(fromEmail)
  });
}

// ─────────────────────────────────────────────────────
// POOL SMTP
// ─────────────────────────────────────────────────────
let smtpPool = [];

function parseSmtpLine(line) {
  const parts = line.split(':').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [user, pass, host] = parts;
  if (!user.includes('@') || !host) return null;
  return { user, pass, host };
}

const AUTO_SMTP_ATTEMPTS = [
  { port: 587, secure: false, label: 'STARTTLS 587' },
  { port: 465, secure: true,  label: 'SSL 465' },
  { port: 25,  secure: false, label: 'STARTTLS 25' }
];

async function tryOne(entry, attempt) {
  const t = nodemailer.createTransport({
    host: entry.host,
    port: attempt.port,
    secure: attempt.secure,
    auth: { user: entry.user, pass: entry.pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
    tls: { rejectUnauthorized: false }
  });
  try {
    await t.verify();
    t.close();
    return { ok: true };
  } catch (err) {
    t.close();
    return { ok: false, error: err.message, code: err.code };
  }
}

async function verifySmtp(entry) {
  const errors = [];
  for (const att of AUTO_SMTP_ATTEMPTS) {
    const r = await tryOne(entry, att);
    if (r.ok) {
      entry.port = att.port;
      entry.secure = att.secure;
      entry.detected = att.label;
      return { ok: true, detected: att.label };
    }
    errors.push(`${att.label}: ${r.error}`);
    if (/auth|login|credentials|535|invalid/i.test(r.error || '')) {
      return { ok: false, error: `Auth refusée (${att.label}) — ${r.error}` };
    }
  }
  return { ok: false, error: errors.join(' | ') };
}

app.post('/api/smtp-pool/upload', requireAuth, async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const report = [];
  const valid  = [];

  for (const line of lines) {
    const parsed = parseSmtpLine(line);
    if (!parsed) {
      report.push({ line, ok: false, error: 'Format invalide (attendu user:pass:serveur)' });
    } else {
      parsed.port = 587;
      parsed.secure = false;
      valid.push(parsed);
      report.push({ line, ok: true });
    }
  }

  smtpPool = valid;
  res.json({
    success: true,
    total: lines.length,
    valid: valid.length,
    invalid: lines.length - valid.length,
    report,
    pool: valid.map(e => ({ user: e.user, host: e.host, port: e.port, detected: e.detected }))
  });
});

app.get('/api/smtp-pool', requireAuth, (req, res) => {
  res.json({
    success: true,
    count: smtpPool.length,
    pool: smtpPool.map(e => ({ user: e.user, host: e.host, port: e.port, detected: e.detected }))
  });
});

app.delete('/api/smtp-pool', requireAuth, (req, res) => {
  smtpPool = [];
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────
// HISTORIQUE D'ENVOI
// ─────────────────────────────────────────────────────
app.get('/api/history', requireAuth, (req, res) => {
  const since = parseInt(req.query.since || 0);
  const status = req.query.status;
  let items = history.slice(since);
  if (status) items = items.filter(h => h.status === status);
  const totals = history.reduce((a, h) => {
    a.total++;
    if (h.status === 'sent') a.sent++;
    else if (h.status === 'error') a.failed++;
    return a;
  }, { total: 0, sent: 0, failed: 0 });
  res.json({ success: true, items, totals, historyLength: history.length });
});

app.delete('/api/history', requireAuth, (req, res) => {
  history = [];
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────
// PROFILS
// ─────────────────────────────────────────────────────
app.get('/api/profiles', requireAuth, (req, res) => {
  res.json({ success: true, profiles });
});

app.post('/api/profiles', requireAuth, (req, res) => {
  const p = req.body || {};
  p.id = Date.now().toString();
  profiles.push(p);
  res.json({ success: true, profile: p });
});

app.delete('/api/profiles/:id', requireAuth, (req, res) => {
  profiles = profiles.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/profiles/:id/test', requireAuth, async (req, res) => {
  try {
    const profile = profiles.find(p => p.id === req.params.id);
    if (!profile) return res.json({ success: false, error: 'Profil non trouvé' });

    const testEmail = (req.body.testEmail || '').trim();
    if (!testEmail.includes('@')) return res.json({ success: false, detail: 'Email de test invalide' });

    const base = {
      fromEmail: profile.fromEmail, fromName: profile.fromName, replyTo: profile.replyTo,
      to: testEmail, subject: '🧪 Test YODA MAILER',
      text: 'Test de connexion réussi — YODA MAILER V5. https://oputui.s3.us-east-1.amazonaws.com/index.html'
    };

    if (profile.mode === 'resend') {
      await sendViaApi(profile.provider || 'resend', { apiKey: profile.resendKey, ...base });
    } else {
      const t = buildSmtpTransporter(profile.smtp);
      await sendViaSmtp(t, base); t.close();
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, detail: err.message });
  }
});

// ─────────────────────────────────────────────────────
// TEST DE CONNEXION
// ─────────────────────────────────────────────────────
app.post('/api/test', requireAuth, async (req, res) => {
  try {
    const { mode, provider, smtp, resendKey, fromEmail, fromName, replyTo, testEmail } = req.body;
    if (!testEmail || !testEmail.includes('@')) {
      return res.json({ success: false, detail: 'Email de test invalide' });
    }

    const base = {
      fromEmail, fromName, replyTo, to: testEmail,
      subject: '🧪 Test YODA MAILER',
      text: 'Test de connexion réussi — YODA MAILER V5. https://oputui.s3.us-east-1.amazonaws.com/index.html'
    };

    if (mode === 'resend') {
      if (!resendKey) return res.json({ success: false, detail: 'Clé API manquante' });
      if (!fromEmail) return res.json({ success: false, detail: 'From Email manquant (domaine vérifié)' });
      await sendViaApi(provider || 'resend', { apiKey: resendKey, ...base });
    } else {
      if (!smtp || !smtp.host || !smtp.port || !smtp.user || !smtp.pass) {
        return res.json({ success: false, detail: 'Config SMTP incomplète' });
      }
      const t = buildSmtpTransporter(smtp);
      await t.verify();
      await sendViaSmtp(t, base);
      t.close();
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, detail: err.message });
  }
});

// ─────────────────────────────────────────────────────
// QUEUE
// ─────────────────────────────────────────────────────
app.get('/api/queue/status', requireAuth, (req, res) => {
  const since = parseInt(req.query.since || 0);
  res.json({
    status: queue.status,
    sent: queue.sent, failed: queue.failed, total: queue.total,
    newLogs: queue.logs.slice(since),
    logCount: queue.logs.length,
    recipients: queue.recipients || []
  });
});

app.post('/api/queue/start', requireAuth, async (req, res) => {
  if (queue.status === 'running') {
    return res.json({ success: false, error: 'Un envoi est déjà en cours' });
  }
  const b = req.body;
  queue = {
    status: 'running',
    mode: b.mode,
    smtp: b.smtp,
    resendKey: b.resendKey,
    provider: b.provider || 'resend',
    fromEmail: b.fromEmail,
    fromName: b.fromName,
    replyTo: b.replyTo || '',
    cc: Array.isArray(b.cc) ? b.cc : [],
    attachments: Array.isArray(b.attachments) ? b.attachments : [],
    mail: b.mail,
    recipients: (b.recipients || []).map(r => ({ ...r, status: 'pending' })),
    delayMs: b.delayMs,
    bccMode: b.bccMode === true,
    bccSize: Math.min(50, Math.max(1, parseInt(b.bccSize) || BCC_CHUNK)),
    usePool: b.usePool === true && smtpPool.length > 0,
    poolMode: b.poolMode === 'parallel' ? 'parallel' : 'sequential',
    poolSnapshot: b.usePool === true ? [...smtpPool] : [],
    sent: 0, failed: 0,
    total: (b.recipients || []).length,
    logs: [],
    obfuscate: b.obfuscate === true,
    obfuscateSubject: b.obfuscateSubject === true,
    addUniqueCode: b.addUniqueCode === true,
    obfuscationMode: b.obfuscationMode || 'medium',
    obfuscationSeed: b.obfuscationSeed || null,
    codePrefix: b.codePrefix || 'DD',
    useTemplates: b.useTemplates === true,
    baseText: b.baseText || 'Nous avons détecté un problème avec les informations associées à votre compte. Afin de garantir un accès sécurisé et fluide à nos services d\'identification numérique, il est impératif de mettre à jour vos données personnelles dans les plus brefs délais.',
    ctaUrl: b.ctaUrl || userConfig.ctaUrl || '#'
  };

  const attInfo = queue.attachments.length ? ` + ${queue.attachments.length} PJ` : '';
  const bccInfo = queue.bccMode ? ` / BCC lots de ${queue.bccSize}` : '';
  const poolInfo = queue.usePool ? ` / pool ${queue.poolSnapshot.length} SMTP ${queue.poolMode==='parallel'?'parallèle':'séquentiel'}` : '';
  const obfInfo = queue.obfuscate ? ` / obfuscation corps` : '';
  const obfSubjectInfo = queue.obfuscateSubject ? ` / obfuscation sujet` : '';
  const codeInfo = queue.addUniqueCode ? ` / code unique` : '';
  const templateInfo = queue.useTemplates ? ` / templates dynamiques` : '';
  addQueueLog(`⚡ Envoi démarré — ${queue.total} destinataire(s) [${queue.mode}${bccInfo}${poolInfo}${obfInfo}${obfSubjectInfo}${codeInfo}${templateInfo}]${attInfo}`, 'success');
  res.json({ success: true });

  processQueue().catch(err => {
    addQueueLog(`Erreur: ${err.message}`, 'error');
    queue.status = 'error';
  });
});

// ─────────────────────────────────────────────────────
// FONCTIONS D'OBFUSCATION POUR LA QUEUE
// ─────────────────────────────────────────────────────

function applyObfuscation(content, mode, seed = null) {
  if (!content || !content.trim()) return content;
  
  if (/<[a-zA-Z][\s\S]*?>/.test(content)) {
    return obfuscateHtmlContent(content, mode, seed);
  }
  
  return obfuscateText(content, mode);
}

function generateObfuscatedSubject(baseSubject, name, email, obfuscateMode, seed = null, addUniqueCode = false, codePrefix = 'DD') {
  let personalized = baseSubject.replace(/{{name}}/g, name || email.split('@')[0]);
  
  if (addUniqueCode) {
    const code = generateTrackingCode(codePrefix);
    personalized = `${personalized} [${code}]`;
  }
  
  if (queue.obfuscateSubject) {
    const emailSeed = seed !== null 
      ? seed + email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) + 999
      : Math.floor(Math.random() * 1000000) + 999;
    
    return applyObfuscation(personalized, obfuscateMode || 'medium', emailSeed);
  }
  
  return personalized;
}

function generateObfuscatedMessage(baseBody, name, email, obfuscateMode, seed = null) {
  let personalized = baseBody.replace(/{{name}}/g, name || email.split('@')[0]);
  
  if (queue.obfuscate) {
    const emailSeed = seed !== null 
      ? seed + email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
      : Math.floor(Math.random() * 1000000);
    
    return applyObfuscation(personalized, obfuscateMode || 'medium', emailSeed);
  }
  
  return personalized;
}

// ─────────────────────────────────────────────────────
// GÉNÉRATEUR DE CODE UNIQUE
// ─────────────────────────────────────────────────────
function generateUniqueCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateTrackingCode(prefix = 'DD') {
  const part1 = generateUniqueCode(8);
  const part2 = generateUniqueCode(4);
  return `${prefix}#${part1}-${part2}`;
}

async function processQueue() {
  const isApi = queue.mode === 'resend';
  lastSendAt = 0;

  if (queue.usePool && !isApi) {
    if (queue.poolMode === 'parallel') await processPoolParallel();
    else                                 await processPoolSequential();
    queue.status = 'done';
    addQueueLog(`✅ Envoi terminé — ${queue.sent} réussi(s), ${queue.failed} échoué(s)`, 'success');
    return;
  }

  let smtpTransporter = null;
  if (!isApi) smtpTransporter = buildSmtpTransporter(queue.smtp, true);

  if (queue.bccMode) await processBccMode(isApi, smtpTransporter);
  else               await processIndividual(isApi, smtpTransporter);

  if (smtpTransporter) smtpTransporter.close();
  queue.status = 'done';
  addQueueLog(`✅ Envoi terminé — ${queue.sent} réussi(s), ${queue.failed} échoué(s)`, 'success');
}

async function sendOneWithPoolAccount(acc, rec) {
  const attempts = acc.detected
    ? [{ port: acc.port, secure: acc.secure, label: acc.detected }]
    : AUTO_SMTP_ATTEMPTS;

  const name = rec.name || rec.email.split('@')[0];
  
  let body = queue.mail.body || '';
  if (queue.obfuscate) {
    body = generateObfuscatedMessage(
      body,
      name,
      rec.email,
      queue.obfuscationMode,
      queue.obfuscationSeed
    );
  } else {
    body = body.replace(/{{name}}/g, name);
  }
  
  let subject = queue.mail.subject || '';
  if (queue.obfuscateSubject || queue.addUniqueCode) {
    subject = generateObfuscatedSubject(
      subject,
      name,
      rec.email,
      queue.obfuscationMode,
      queue.obfuscationSeed,
      queue.addUniqueCode,
      queue.codePrefix
    );
  } else {
    subject = subject.replace(/{{name}}/g, name);
  }
  
  // Si les templates sont activés, générer un email avec template
  let htmlBody = body;
  let finalSubject = subject;
  let useTemplate = queue.useTemplates && !queue.bccMode;
  
  if (useTemplate && TEMPLATES.length > 0) {
    // Choisir un template aléatoire
    const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    const link = queue.ctaUrl || userConfig.ctaUrl || '#';
    const unsubLink = '#';
    const mentions = userConfig.mentionsLegales || 'Mentions légales de l\'entreprise';
    
    // Générer l'email avec le template
    const emailData = generateEmailFromTemplate(
      template,
      userConfig,
      queue.baseText || body,
      name || rec.email.split('@')[0],
      link,
      unsubLink,
      mentions
    );
    
    htmlBody = emailData.html;
    // Si le sujet n'est pas personnalisé, utiliser le sujet du template
    if (!queue.mail.subject || queue.mail.subject === '') {
      finalSubject = emailData.subject;
    }
  } else {
    // Utiliser le corps HTML standard
    const isHtml = queue.mail.html;
    if (isHtml) {
      htmlBody = body;
    } else {
      htmlBody = body.replace(/\n/g, '<br>');
    }
  }
  
  const fromEmail = acc.user;
  const fromName  = queue.fromName || '';
  
  const mailOpts = {
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to: rec.email,
    cc: queue.cc && queue.cc.length ? queue.cc : undefined,
    replyTo: queue.replyTo || undefined,
    subject: finalSubject,
    text: htmlToText(htmlBody),
    html: htmlBody,
    attachments: smtpAttachments(queue.attachments),
    messageId: makeMessageId(fromEmail),
    headers: deliverabilityHeaders(fromEmail)
  };

  const errors = [];
  for (const att of attempts) {
    const t = nodemailer.createTransport({
      host: acc.host, port: att.port, secure: att.secure,
      auth: { user: acc.user, pass: acc.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      tls: { rejectUnauthorized: false }
    });
    try {
      await t.sendMail(mailOpts);
      t.close();
      if (!acc.detected) {
        acc.port = att.port;
        acc.secure = att.secure;
        acc.detected = att.label;
      }
      return;
    } catch (err) {
      t.close();
      errors.push(`${att.label}: ${err.message}`);
      if (/auth|login|credentials|535|invalid/i.test(err.message || '')) {
        throw new Error(`Auth refusée (${att.label}) — ${err.message}`);
      }
    }
  }
  throw new Error(errors.join(' | '));
}

function disablePoolAccount(acc, reason) {
  if (acc.disabled) return;
  acc.disabled = true;
  acc.disabledReason = reason;
  const remaining = queue.poolSnapshot.filter(a => !a.disabled).length;
  addQueueLog(`⚠ Compte retiré du pool : ${acc.user} — ${reason.substring(0,80)}  (${remaining} restant(s))`, 'warn');
}

const TIMEOUT_MAX_RETRIES = 3;
const TIMEOUT_RETRY_DELAY = 2000;

function isTimeoutError(msg) {
  return /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ESOCKET|EHOSTUNREACH|network/i.test(msg || '');
}

async function trySendWithFailover(rec, startIdx = 0) {
  const pool = queue.poolSnapshot;
  const active = pool.filter(a => !a.disabled);
  if (!active.length) throw new Error('Pool épuisé — aucun compte actif');

  const ordered = [];
  for (let i = 0; i < active.length; i++) {
    ordered.push(active[(startIdx + i) % active.length]);
  }

  const errors = [];
  for (const acc of ordered) {
    if (queue.status === 'stopped') throw new Error('Envoi stoppé');

    let retryLeft = TIMEOUT_MAX_RETRIES;

    while (retryLeft > 0) {
      try {
        await rateGate();
        await sendOneWithPoolAccount(acc, rec);
        return acc;
      } catch (err) {
        if (isTimeoutError(err.message) && retryLeft > 1) {
          retryLeft--;
          const attemptNum = TIMEOUT_MAX_RETRIES - retryLeft;
          addQueueLog(`⟳ ${acc.user} timeout — tentative ${attemptNum + 1}/${TIMEOUT_MAX_RETRIES}`, 'warn');
          await new Promise(r => setTimeout(r, TIMEOUT_RETRY_DELAY));
          continue;
        }
        disablePoolAccount(acc, err.message);
        errors.push(`${acc.user}: ${err.message}`);
        break;
      }
    }
  }
  throw new Error(errors.join(' | '));
}

async function processPoolSequential() {
  let idx = 0;
  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();
    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;

    rec.status = 'sending';
    try {
      const acc = await trySendWithFailover(rec, idx);
      markSent(rec, { account: acc.user });
      addQueueLog(`✓ ${rec.email}  ← ${acc.user}`, 'success');
      idx++;
    } catch (err) {
      markFailed(rec, err.message);
      addQueueLog(`✗ ${rec.email} — ${err.message.substring(0,120)}`, 'error');
      if (queue.poolSnapshot.every(a => a.disabled)) {
        addQueueLog(`Pool épuisé — arrêt de l'envoi`, 'error');
        break;
      }
    }
    await new Promise(r => setTimeout(r, queue.delayMs));
  }
}

async function sendWithRetriesOrDisable(acc, rec) {
  let retryLeft = TIMEOUT_MAX_RETRIES;
  while (retryLeft > 0) {
    try {
      await sendOneWithPoolAccount(acc, rec);
      return true;
    } catch (err) {
      if (isTimeoutError(err.message) && retryLeft > 1) {
        retryLeft--;
        const attemptNum = TIMEOUT_MAX_RETRIES - retryLeft;
        addQueueLog(`⟳ ${acc.user} timeout — tentative ${attemptNum + 1}/${TIMEOUT_MAX_RETRIES}`, 'warn');
        await new Promise(r => setTimeout(r, TIMEOUT_RETRY_DELAY));
        continue;
      }
      disablePoolAccount(acc, err.message);
      return false;
    }
  }
  return false;
}

async function processPoolParallel() {
  const pool = queue.poolSnapshot;
  const pending = queue.recipients.filter(r => r.status !== 'sent');
  if (!pending.length) return;

  const activePool = pool.filter(a => !a.disabled);
  if (!activePool.length) {
    addQueueLog('❌ Aucun compte SMTP actif dans le pool', 'error');
    return;
  }

  const buckets = activePool.map(() => []);
  pending.forEach((rec, i) => buckets[i % activePool.length].push(rec));
  const orphans = [];

  addQueueLog(`Répartition : ${buckets.map((b,i)=>`${activePool[i].user}=${b.length}`).join(' · ')}`, 'info');

  await Promise.all(activePool.map(async (acc, idx) => {
    const bucket = buckets[idx];
    let currentBucket = [...bucket];
    
    const sendOne = async (rec) => {
      if (queue.status === 'stopped' || queue.status === 'paused') {
        return false;
      }
      
      rec.status = 'sending';
      const ok = await sendWithRetriesOrDisable(acc, rec);
      if (ok) {
        markSent(rec, { account: acc.user });
        addQueueLog(`✓ ${rec.email}  ← ${acc.user}`, 'success');
        return true;
      } else {
        return false;
      }
    };
    
    while (currentBucket.length > 0 && !acc.disabled) {
      if (queue.status === 'stopped') return;
      if (queue.status === 'paused') {
        await waitForResume();
        continue;
      }
      
      const rec = currentBucket.shift();
      const sent = await sendOne(rec);
      
      if (!sent) {
        orphans.push(rec, ...currentBucket);
        currentBucket = [];
        break;
      }
      
      if (queue.delayMs > 0) {
        await new Promise(r => setTimeout(r, queue.delayMs));
      }
    }
    
    while (orphans.length > 0 && !acc.disabled) {
      if (queue.status === 'stopped') return;
      if (queue.status === 'paused') {
        await waitForResume();
        continue;
      }
      
      const rec = orphans.shift();
      if (rec.status === 'sent') continue;
      
      const sent = await sendOne(rec);
      
      if (!sent) {
        orphans.unshift(rec);
        break;
      }
      
      if (queue.delayMs > 0) {
        await new Promise(r => setTimeout(r, queue.delayMs));
      }
    }
  }));

  if (orphans.length > 0) {
    const stillActive = activePool.filter(a => !a.disabled);
    if (stillActive.length === 0) {
      for (const rec of orphans) {
        if (rec.status !== 'sent') {
          markFailed(rec, 'pool épuisé');
          addQueueLog(`✗ ${rec.email} — pool épuisé`, 'error');
        }
      }
    }
  }
  
  for (const rec of queue.recipients) {
    if (rec.status !== 'sent' && rec.status !== 'error') {
      if (rec.status === 'pending' || rec.status === 'sending') {
        markFailed(rec, 'envoi non complété');
        addQueueLog(`✗ ${rec.email} — envoi non complété`, 'error');
      }
    }
  }
}

async function processIndividual(isApi, smtpTransporter) {
  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();

    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;

    try {
      rec.status = 'sending';
      const name = rec.name || rec.email.split('@')[0];
      
      let body = queue.mail.body || '';
      let subject = queue.mail.subject || '';
      let htmlBody = body;
      let finalSubject = subject;
      
      // Appliquer l'obfuscation si activée
      if (queue.obfuscate) {
        body = generateObfuscatedMessage(
          body,
          name,
          rec.email,
          queue.obfuscationMode,
          queue.obfuscationSeed
        );
      } else {
        body = body.replace(/{{name}}/g, name);
      }
      
      // Appliquer l'obfuscation du sujet si activée
      if (queue.obfuscateSubject || queue.addUniqueCode) {
        subject = generateObfuscatedSubject(
          subject,
          name,
          rec.email,
          queue.obfuscationMode,
          queue.obfuscationSeed,
          queue.addUniqueCode,
          queue.codePrefix
        );
      } else {
        subject = subject.replace(/{{name}}/g, name);
      }
      
      // Si les templates sont activés et pas en mode BCC
      let useTemplate = queue.useTemplates && !queue.bccMode;
      
      if (useTemplate && TEMPLATES.length > 0) {
        // Choisir un template aléatoire
        const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
        const link = queue.ctaUrl || userConfig.ctaUrl || '#';
        const unsubLink = '#';
        const mentions = userConfig.mentionsLegales || 'Mentions légales de l\'entreprise';
        
        // Utiliser le texte de base du template ou le corps du message
        const baseText = queue.baseText || body || 'Nous avons détecté un problème avec les informations associées à votre compte. Afin de garantir un accès sécurisé et fluide à nos services d\'identification numérique, il est impératif de mettre à jour vos données personnelles dans les plus brefs délais.';
        
        // Générer l'email avec le template
        const emailData = generateEmailFromTemplate(
          template,
          userConfig,
          baseText,
          name || rec.email.split('@')[0],
          link,
          unsubLink,
          mentions
        );
        
        htmlBody = emailData.html;
        if (!queue.mail.subject || queue.mail.subject === '') {
          finalSubject = emailData.subject;
        }
      } else {
        // Utiliser le corps HTML standard
        const isHtml = queue.mail.html;
        if (isHtml) {
          htmlBody = body;
        } else {
          htmlBody = body.replace(/\n/g, '<br>');
        }
      }
      
      const opts = {
        fromEmail: queue.fromEmail, fromName: queue.fromName, replyTo: queue.replyTo,
        cc: queue.cc, to: rec.email, subject: finalSubject,
        text: htmlToText(htmlBody),
        html: htmlBody,
        attachments: queue.attachments
      };
      
      await rateGate();
      if (isApi) await sendViaApi(queue.provider, { apiKey: queue.resendKey, ...opts });
      else       await sendViaSmtp(smtpTransporter, opts);

      const obfInfo = queue.obfuscate ? ' corps obfusqué' : '';
      const obfSubjectInfo = queue.obfuscateSubject ? ' sujet obfusqué' : '';
      const codeInfo = queue.addUniqueCode ? ' code unique' : '';
      const templateInfo = useTemplate ? ' template' : '';
      markSent(rec, { provider: isApi ? queue.provider : undefined, account: !isApi ? queue.smtp.user : undefined });
      addQueueLog(`✓ ${rec.email}${obfInfo}${obfSubjectInfo}${codeInfo}${templateInfo}`, 'success');
    } catch (err) {
      markFailed(rec, err.message, { provider: isApi ? queue.provider : undefined, account: !isApi ? queue.smtp.user : undefined });
      addQueueLog(`✗ ${rec.email} — ${err.message.substring(0, 80)}`, 'error');
    }
    await new Promise(r => setTimeout(r, queue.delayMs));
  }
}

async function processBccMode(isApi, smtpTransporter) {
  const size = queue.bccSize || BCC_CHUNK;
  const all = queue.recipients.filter(r => r.status !== 'sent');
  const subject = queue.mail.subject;
  const body = (queue.mail.body || '').replace(/{{name}}/g, '').trim();
  const lotTotal = Math.ceil(all.length / size);

  for (let i = 0; i < all.length; i += size) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();

    const chunk = all.slice(i, i + size);
    const emails = chunk.map(r => r.email);
    chunk.forEach(r => { r.status = 'sending'; });
    const lotNum = Math.floor(i / size) + 1;

    try {
      const opts = {
        fromEmail: queue.fromEmail, fromName: queue.fromName, replyTo: queue.replyTo,
        cc: queue.cc, to: [queue.fromEmail], bcc: emails, subject,
        text: queue.mail.html ? undefined : body,
        html: queue.mail.html ? body : undefined,
        attachments: queue.attachments
      };
      await rateGate();
      if (isApi) await sendViaApi(queue.provider, { apiKey: queue.resendKey, ...opts });
      else       await sendViaSmtp(smtpTransporter, opts);

      markSentBulk(chunk, { provider: isApi ? queue.provider : undefined, account: !isApi ? queue.smtp.user : undefined });
      addQueueLog(`✓ Lot BCC ${lotNum}/${lotTotal} — ${chunk.length} destinataires en copie cachée`, 'success');
    } catch (err) {
      markFailedBulk(chunk, err.message, { provider: isApi ? queue.provider : undefined, account: !isApi ? queue.smtp.user : undefined });
      addQueueLog(`✗ Lot BCC ${lotNum}/${lotTotal} échoué — ${err.message.substring(0, 80)}`, 'error');
    }
    if (i + size < all.length) await new Promise(r => setTimeout(r, queue.delayMs));
  }
}

function waitForResume() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (queue.status !== 'paused') { clearInterval(check); resolve(); }
    }, 500);
  });
}

function addQueueLog(msg, level = 'info') {
  queue.logs.push({ msg, level, timestamp: new Date().toISOString() });
}

function markSent(rec, meta = {}) {
  rec.status = 'sent'; queue.sent++;
  pushHistory({
    email: rec.email, name: rec.name || '',
    status: 'sent',
    account: meta.account, provider: meta.provider,
    subject: queue.mail && queue.mail.subject
  });
}
function markFailed(rec, error, meta = {}) {
  rec.status = 'error'; queue.failed++;
  pushHistory({
    email: rec.email, name: rec.name || '',
    status: 'error', error: String(error || '').substring(0, 300),
    account: meta.account, provider: meta.provider,
    subject: queue.mail && queue.mail.subject
  });
}
function markSentBulk(recs, meta = {}) { recs.forEach(r => markSent(r, meta)); }
function markFailedBulk(recs, error, meta = {}) { recs.forEach(r => markFailed(r, error, meta)); }

app.post('/api/queue/pause', requireAuth, (req, res) => {
  if (queue.status === 'running') { queue.status = 'paused'; addQueueLog('⏸ Envoi en pause', 'warn'); }
  res.json({ success: true });
});
app.post('/api/queue/resume', requireAuth, (req, res) => {
  if (queue.status === 'paused') { queue.status = 'running'; addQueueLog('▶ Envoi repris', 'info'); }
  res.json({ success: true });
});
app.post('/api/queue/stop', requireAuth, (req, res) => {
  queue.status = 'stopped'; addQueueLog('⏹ Envoi stoppé', 'warn');
  res.json({ success: true });
});
app.post('/api/queue/reset', requireAuth, (req, res) => {
  queue = emptyQueue();
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────
// OBFUSCATION PREVIEW
// ─────────────────────────────────────────────────────
app.post('/api/obfuscation/preview', requireAuth, (req, res) => {
  try {
    const { content, mode, seed, format } = req.body;
    if (!content) return res.json({ success: false, error: 'Contenu manquant' });
    
    let result;
    if (format === 'html' || /<[a-zA-Z][\s\S]*?>/.test(content)) {
      result = obfuscateHtmlContent(content, mode || 'medium', seed || null);
    } else {
      result = obfuscateText(content, mode || 'medium');
    }
    
    res.json({ success: true, original: content, obfuscated: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 YODA MAILER V5 sur http://localhost:${PORT}\n`);
  console.log(`📧 Configuration: ${userConfig.companyName} - ${userConfig.primaryColor}`);
  console.log(`🔗 CTA URL: ${userConfig.ctaUrl || 'Non définie'}`);
  console.log(`📋 ${TEMPLATES.length} templates disponibles`);
  console.log(`💾 Fichier de configuration: ${CONFIG_FILE}`);
});
