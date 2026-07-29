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
async function sendViaResend(opts) {
  const { apiKey, fromEmail, fromName, to, cc, bcc, replyTo, subject, text, html, attachments } = opts;
  if (!apiKey)   throw new Error('Clé API Resend manquante');
  if (!fromEmail) throw new Error('From Email manquant (domaine vérifié Resend)');

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const payload = { from, to: Array.isArray(to) ? to : [to], subject };

  if (cc && cc.length)   payload.cc = cc;
  if (bcc && bcc.length) payload.bcc = bcc;
  if (replyTo)           payload.reply_to = replyTo;
  if (html) payload.html = html; else payload.text = text || '';
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }));
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
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
      await sendViaResend({ apiKey: profile.resendKey, ...base });
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
    const { mode, smtp, resendKey, fromEmail, fromName, replyTo, testEmail } = req.body;
    if (!testEmail || !testEmail.includes('@')) {
      return res.json({ success: false, detail: 'Email de test invalide' });
    }

    const base = {
      fromEmail, fromName, replyTo, to: testEmail,
      subject: '🧪 Test YODA MAILER',
      text: 'Test de connexion réussi — YODA MAILER V5.'
    };

    if (mode === 'resend') {
      if (!resendKey) return res.json({ success: false, detail: 'Clé API Resend manquante' });
      if (!fromEmail) return res.json({ success: false, detail: 'From Email manquant (domaine vérifié)' });
      await sendViaResend({ apiKey: resendKey, ...base });
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
    sent: 0, failed: 0,
    total: (b.recipients || []).length,
    logs: []
  };

  const attInfo = queue.attachments.length ? ` + ${queue.attachments.length} PJ` : '';
  const bccInfo = queue.bccMode ? ` / BCC lots de ${queue.bccSize}` : '';
  addQueueLog(`⚡ Envoi démarré — ${queue.total} destinataire(s) [${queue.mode}${bccInfo}]${attInfo}`, 'success');
  res.json({ success: true });

  processQueue().catch(err => {
    addQueueLog(`Erreur: ${err.message}`, 'error');
    queue.status = 'error';
  });
});

async function processQueue() {
  const isResend = queue.mode === 'resend';
  lastSendAt = 0; // réinitialise le limiteur de débit
  let smtpTransporter = null;
  if (!isResend) smtpTransporter = buildSmtpTransporter(queue.smtp, true);

  if (queue.bccMode) await processBccMode(isResend, smtpTransporter);
  else               await processIndividual(isResend, smtpTransporter);

  if (smtpTransporter) smtpTransporter.close();
  queue.status = 'done';
  addQueueLog(`✅ Envoi terminé — ${queue.sent} réussi(s), ${queue.failed} échoué(s)`, 'success');
}

// 1 mail par destinataire — personnalisation {{name}} active
async function processIndividual(isResend, smtpTransporter) {
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
      if (isResend) await sendViaResend({ apiKey: queue.resendKey, ...opts });
      else          await sendViaSmtp(smtpTransporter, opts);

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
async function processBccMode(isResend, smtpTransporter) {
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
      if (isResend) await sendViaResend({ apiKey: queue.resendKey, ...opts });
      else          await sendViaSmtp(smtpTransporter, opts);

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
