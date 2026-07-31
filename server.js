/**
 * YODA MAILER V5 — Backend
 * Plateforme d'emailing : Resend (API HTTPS) + SMTP, avec gate d'accès par code.
 * Fonctions : envoi individuel (perso {{name}}), envoi groupé BCC, pièces jointes,
 * reply-to, cc, test de connexion, profils, envoi en arrière-plan (pause/reprise/stop).
 */

const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
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
const sessions = new Map(); // token -> expiresAt

function emptyQueue() {
  return { status: 'idle', recipients: [], logs: [], sent: 0, failed: 0, total: 0 };
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
// HELPERS D'ENVOI
// ─────────────────────────────────────────────────────
const asArray = x => Array.isArray(x) ? x : (x ? [x] : []);

// Registre des fournisseurs d'API HTTP. Chaque adaptateur = endpoint + en-têtes + corps + lecture d'erreur.
// Formats vérifiés sur les docs officielles (2026). Ajouter un fournisseur = ajouter une entrée ici.
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

// Dispatcher générique : envoie via le fournisseur choisi.
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

async function sendViaSmtp(transporter, opts) {
  const { fromEmail, fromName, to, cc, bcc, replyTo, subject, text, html, attachments } = opts;
  return transporter.sendMail({
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to,
    cc: cc && cc.length ? cc : undefined,
    bcc: bcc && bcc.length ? bcc : undefined,
    replyTo: replyTo || undefined,
    subject,
    text: html ? undefined : text,
    html: html ? html : undefined,
    attachments: smtpAttachments(attachments)
  });
}

// ─────────────────────────────────────────────────────
// POOL SMTP — plusieurs comptes SMTP uploadés en masse
// Format ligne : user:pass:serveur  (port=587, STARTTLS par défaut)
// ─────────────────────────────────────────────────────
let smtpPool = [];  // [{ user, pass, host, port:587, secure:false, ok:true }]

function parseSmtpLine(line) {
  const parts = line.split(':').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [user, pass, host] = parts;
  if (!user.includes('@') || !host) return null;
  // Le port/chiffrement seront auto-détectés par verifySmtp
  return { user, pass, host };
}

// Essaie plusieurs combinaisons port/chiffrement, retient la première qui marche
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
    // Rend plus tolérant : certains serveurs OVH/perso ont des certifs auto-signés
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
      // Injecte le port/secure gagnants dans l'entrée
      entry.port = att.port;
      entry.secure = att.secure;
      entry.detected = att.label;
      return { ok: true, detected: att.label };
    }
    errors.push(`${att.label}: ${r.error}`);
    // Si l'auth a été refusée à un port, inutile d'insister sur les autres
    if (/auth|login|credentials|535|invalid/i.test(r.error || '')) {
      return { ok: false, error: `Auth refusée (${att.label}) — ${r.error}` };
    }
  }
  return { ok: false, error: errors.join(' | ') };
}

// POST /api/smtp-pool/upload — reçoit { text } (contenu du .txt),
// teste chaque ligne, retire les invalides, remplace le pool.
app.post('/api/smtp-pool/upload', requireAuth, async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const report = [];  // { line, ok, error? }
  const valid  = [];

  // Test en parallèle (limité à 10 en même temps pour ne pas saturer)
  const CONCURRENCY = 10;
  for (let i = 0; i < lines.length; i += CONCURRENCY) {
    const batch = lines.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async line => {
      const parsed = parseSmtpLine(line);
      if (!parsed) return { line, ok: false, error: 'Format invalide (attendu user:pass:serveur)' };
      const v = await verifySmtp(parsed);
      return { line, ok: v.ok, error: v.error, detected: v.detected, entry: parsed };
    }));
    for (const r of results) {
      report.push({ line: r.line, ok: r.ok, error: r.error, detected: r.detected });
      if (r.ok) valid.push(r.entry);
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

// GET /api/smtp-pool — renvoie l'état actuel du pool
app.get('/api/smtp-pool', requireAuth, (req, res) => {
  res.json({
    success: true,
    count: smtpPool.length,
    pool: smtpPool.map(e => ({ user: e.user, host: e.host, port: e.port, detected: e.detected }))
  });
});

// DELETE /api/smtp-pool — vide le pool
app.delete('/api/smtp-pool', requireAuth, (req, res) => {
  smtpPool = [];
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
      text: 'Test de connexion réussi — YODA MAILER V5.'
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
      text: 'Test de connexion réussi — YODA MAILER V5.'
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
    logs: []
  };

  const attInfo = queue.attachments.length ? ` + ${queue.attachments.length} PJ` : '';
  const bccInfo = queue.bccMode ? ` / BCC lots de ${queue.bccSize}` : '';
  const poolInfo = queue.usePool ? ` / pool ${queue.poolSnapshot.length} SMTP ${queue.poolMode==='parallel'?'parallèle':'séquentiel'}` : '';
  addQueueLog(`⚡ Envoi démarré — ${queue.total} destinataire(s) [${queue.mode}${bccInfo}${poolInfo}]${attInfo}`, 'success');
  res.json({ success: true });

  processQueue().catch(err => {
    addQueueLog(`Erreur: ${err.message}`, 'error');
    queue.status = 'error';
  });
});

async function processQueue() {
  const isApi = queue.mode === 'resend';
  lastSendAt = 0; // réinitialise le limiteur de débit

  // Cas pool SMTP : ignore le SMTP unique, utilise les comptes uploadés
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

// Un mail envoyé via un compte SMTP donné (pool)
async function sendOneWithPoolAccount(acc, rec) {
  const t = nodemailer.createTransport({
    host: acc.host, port: acc.port, secure: acc.secure,
    auth: { user: acc.user, pass: acc.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  try {
    const name = rec.name || rec.email.split('@')[0];
    const body = (queue.mail.body || '').replace(/{{name}}/g, name);
    // Le From par défaut vient du compte SMTP lui-même (rassure les serveurs)
    // mais on garde fromName si l'utilisateur en a défini un.
    const fromEmail = queue.fromEmail || acc.user;
    const fromName  = queue.fromName || '';
    await t.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to: rec.email,
      cc: queue.cc && queue.cc.length ? queue.cc : undefined,
      replyTo: queue.replyTo || undefined,
      subject: queue.mail.subject,
      text: queue.mail.html ? undefined : body,
      html: queue.mail.html ? body : undefined,
      attachments: smtpAttachments(queue.attachments)
    });
  } finally {
    t.close();
  }
}

// POOL SÉQUENTIEL : les SMTP tournent en rond, un mail après l'autre
async function processPoolSequential() {
  const pool = queue.poolSnapshot;
  let idx = 0;
  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();
    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;
    const acc = pool[idx % pool.length]; idx++;
    try {
      rec.status = 'sending';
      await rateGate();
      await sendOneWithPoolAccount(acc, rec);
      rec.status = 'sent'; queue.sent++;
      addQueueLog(`✓ ${rec.email}  ← ${acc.user}`, 'success');
    } catch (err) {
      rec.status = 'error'; queue.failed++;
      addQueueLog(`✗ ${rec.email}  ← ${acc.user} — ${err.message.substring(0,80)}`, 'error');
    }
    await new Promise(r => setTimeout(r, queue.delayMs));
  }
}

// POOL PARALLÈLE : la liste est découpée en tranches, une par SMTP, envoyées en parallèle
async function processPoolParallel() {
  const pool = queue.poolSnapshot;
  const pending = queue.recipients.filter(r => r.status !== 'sent');
  if (!pending.length) return;

  // Répartition round-robin des destinataires entre les comptes du pool
  const buckets = pool.map(() => []);
  pending.forEach((rec, i) => buckets[i % pool.length].push(rec));

  addQueueLog(`Répartition : ${buckets.map((b,i)=>`${pool[i].user}=${b.length}`).join(' · ')}`, 'info');

  // Chaque compte traite sa tranche séquentiellement (mais tous en parallèle entre eux)
  await Promise.all(pool.map(async (acc, i) => {
    const bucket = buckets[i];
    for (const rec of bucket) {
      if (queue.status === 'stopped') break;
      if (queue.status === 'paused') await waitForResume();
      try {
        rec.status = 'sending';
        await sendOneWithPoolAccount(acc, rec);
        rec.status = 'sent'; queue.sent++;
        addQueueLog(`✓ ${rec.email}  ← ${acc.user}`, 'success');
      } catch (err) {
        rec.status = 'error'; queue.failed++;
        addQueueLog(`✗ ${rec.email}  ← ${acc.user} — ${err.message.substring(0,80)}`, 'error');
      }
      // Délai par compte (chaque compte respecte son propre rythme)
      if (queue.delayMs > 0) await new Promise(r => setTimeout(r, queue.delayMs));
    }
  }));
}

// 1 mail par destinataire — personnalisation {{name}} active
async function processIndividual(isApi, smtpTransporter) {
  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();

    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;

    try {
      rec.status = 'sending';
      const name = rec.name || rec.email.split('@')[0];
      const body = (queue.mail.body || '').replace(/{{name}}/g, name);
      const opts = {
        fromEmail: queue.fromEmail, fromName: queue.fromName, replyTo: queue.replyTo,
        cc: queue.cc, to: rec.email, subject: queue.mail.subject,
        text: queue.mail.html ? undefined : body,
        html: queue.mail.html ? body : undefined,
        attachments: queue.attachments
      };
      await rateGate(); // ne jamais dépasser 10 requêtes/seconde
      if (isApi) await sendViaApi(queue.provider, { apiKey: queue.resendKey, ...opts });
      else       await sendViaSmtp(smtpTransporter, opts);

      rec.status = 'sent'; queue.sent++;
      addQueueLog(`✓ ${rec.email}`, 'success');
    } catch (err) {
      rec.status = 'error'; queue.failed++;
      addQueueLog(`✗ ${rec.email} — ${err.message.substring(0, 80)}`, 'error');
    }
    await new Promise(r => setTimeout(r, queue.delayMs));
  }
}

// 1 mail par lot — toute la liste en copie cachée (perso {{name}} impossible)
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
      await rateGate(); // ne jamais dépasser 10 requêtes/seconde
      if (isApi) await sendViaApi(queue.provider, { apiKey: queue.resendKey, ...opts });
      else       await sendViaSmtp(smtpTransporter, opts);

      chunk.forEach(r => { r.status = 'sent'; });
      queue.sent += chunk.length;
      addQueueLog(`✓ Lot BCC ${lotNum}/${lotTotal} — ${chunk.length} destinataires en copie cachée`, 'success');
    } catch (err) {
      chunk.forEach(r => { r.status = 'error'; });
      queue.failed += chunk.length;
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 YODA MAILER V5 sur http://localhost:${PORT}\n`);
});
