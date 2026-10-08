const https = require('https');
const fs = require('fs');
const path = require('path');

function resolveResendKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY.trim();
  const candidates = [
    path.join(process.env.NATIVE_DATA_DIR || process.env.NATIVE_SKIN_DATA || '', 'resend.key'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf8');
        const match = text.match(/RESEND_API_KEY\s*=\s*(.+)/);
        if (match && match[1].trim()) return match[1].trim();
      }
    } catch {}
  }
  return '';
}

function resolveSendGridKey() {
  if (process.env.SENDGRID_API_KEY) return process.env.SENDGRID_API_KEY.trim();
  const candidates = [
    path.join(process.env.NATIVE_DATA_DIR || process.env.NATIVE_SKIN_DATA || '', 'sendgrid.key'),
    '/home/ubuntu/.local/share/native-skin-api/sendgrid.key',
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', 'skin-server', 'data', 'sendgrid.key')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf8');
        const match = text.match(/SENDGRID_API_KEY\s*=\s*(.+)/);
        if (match && match[1].trim()) return match[1].trim();
        if (text.startsWith('SG.')) return text.trim();
      }
    } catch {}
  }
  return '';
}

const DEFAULT_SENDER = {
  email: process.env.NATIVE_SECURITY_EMAIL || 'noreply@playnative.fun',
  name: 'Native Security'
};

const REPLY_TO = {
  email: process.env.NATIVE_SUPPORT_EMAIL || 'itznavidu@gmail.com',
  name: 'Native Support'
};

const FOOTER_ADDRESS = 'No.27, Jayanthipura, Wekada, Panadura, 12500 LKA';

/**
 * Send an email via Resend API (https://resend.com)
 */
function sendResendEmail({ to, subject, html, text, from = DEFAULT_SENDER, replyTo = REPLY_TO }, apiKey) {
  return new Promise((resolve, reject) => {
    const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
    const replyToHeader = replyTo?.email ? (replyTo.name ? `${replyTo.name} <${replyTo.email}>` : replyTo.email) : undefined;
    
    const payload = JSON.stringify({
      from: fromHeader,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {}),
      ...(replyToHeader ? { reply_to: replyToHeader } : {})
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, provider: 'resend', statusCode: res.statusCode });
        } else {
          try {
            const parsed = JSON.parse(data);
            const msg = parsed?.message || parsed?.error?.message || data || `Resend returned status ${res.statusCode}`;
            reject(new Error(msg));
          } catch {
            reject(new Error(`Resend returned status ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send an email via SendGrid v3 API
 */
function sendSendGridEmail({ to, subject, html, text, from = DEFAULT_SENDER, replyTo = REPLY_TO }, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from,
      reply_to: replyTo,
      subject,
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        { type: 'text/html', value: html }
      ]
    });

    const options = {
      hostname: 'api.sendgrid.com',
      port: 443,
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, provider: 'sendgrid', statusCode: res.statusCode });
        } else {
          try {
            const parsed = JSON.parse(data);
            const msg = parsed?.errors?.[0]?.message || data || `SendGrid returned status ${res.statusCode}`;
            reject(new Error(msg));
          } catch {
            reject(new Error(`SendGrid returned status ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Universal email dispatcher: Resend -> SendGrid -> Dev Console
 */
function sendEmail(options) {
  if (!options.from) {
    let email = DEFAULT_SENDER.email;
    try { email = require('./domains').senderEmail(email); } catch {}
    options = { ...options, from: { ...DEFAULT_SENDER, email } };
  }
  const resendKey = resolveResendKey();
  if (resendKey) {
    return sendResendEmail(options, resendKey);
  }

  const sendgridKey = resolveSendGridKey();
  if (sendgridKey) {
    return sendSendGridEmail(options, sendgridKey);
  }

  // Fallback for development/testing if no API keys are present
  console.log(`[Native Mailer (Dev Mode)] No RESEND_API_KEY or SENDGRID_API_KEY configured. Email payload:`, {
    to: options.to,
    subject: options.subject
  });
  return Promise.resolve({ ok: true, provider: 'mock', dev: true });
}

/**
 * Send a 6-digit verification code to the given email.
 */
async function sendVerificationCodeEmail(email, code, username = '') {
  const subject = `Native Client — Verification Code: ${code}`;
  const text = `Your Native verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\n${FOOTER_ADDRESS}`;
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Code</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0b080c; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ece6ed; }
    .wrapper { width: 100%; max-width: 520px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #161218; border: 1px solid rgba(160, 81, 162, 0.25); border-radius: 16px; padding: 36px 28px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { font-size: 22px; font-weight: 700; color: #ffffff; margin: 0 0 10px; letter-spacing: -0.02em; }
    p { font-size: 14px; color: #a9a0ad; line-height: 1.5; margin: 0 0 24px; }
    .code-box { background: rgba(160, 81, 162, 0.12); border: 1px solid rgba(160, 81, 162, 0.35); border-radius: 12px; padding: 18px 24px; margin: 0 auto 28px; display: inline-block; }
    .code { font-family: 'SF Mono', Monaco, Menlo, 'Courier New', monospace; font-size: 36px; font-weight: 700; color: #ffffff; letter-spacing: 8px; margin: 0; }
    .expire { font-size: 12px; color: #887e8d; margin-top: 10px; margin-bottom: 0; }
    .footer { margin-top: 32px; font-size: 11px; color: #69606d; text-align: center; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <h1>Native Client</h1>
      <p>Hello${username ? ` <strong>${username}</strong>` : ''},<br>Use the following 6-digit verification code to complete your Native account setup:</p>
      
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="expire">Expires in 10 minutes</div>
      </div>
      
      <p style="font-size: 12px; color: #807685; margin: 0;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      Native Client &bull; Native Security<br>
      ${FOOTER_ADDRESS}
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to: email, subject, html, text });
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

/**
 * Send a 6-digit password reset code to the given email.
 */
async function sendPasswordResetEmail(email, code, username = '') {
  const subject = `Native Client — Password Reset Code: ${code}`;
  const text = `Your Native password reset code is: ${code}\n\nThis code will expire in 15 minutes. If you didn't ask to reset your password, you can ignore this email and your password will stay the same.\n\n${FOOTER_ADDRESS}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0b080c; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ece6ed; }
    .wrapper { width: 100%; max-width: 520px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #161218; border: 1px solid rgba(160, 81, 162, 0.25); border-radius: 16px; padding: 36px 28px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { font-size: 22px; font-weight: 700; color: #ffffff; margin: 0 0 10px; letter-spacing: -0.02em; }
    p { font-size: 14px; color: #a9a0ad; line-height: 1.5; margin: 0 0 24px; }
    .code-box { background: rgba(160, 81, 162, 0.12); border: 1px solid rgba(160, 81, 162, 0.35); border-radius: 12px; padding: 18px 24px; margin: 0 auto 28px; display: inline-block; }
    .code { font-family: 'SF Mono', Monaco, Menlo, 'Courier New', monospace; font-size: 36px; font-weight: 700; color: #ffffff; letter-spacing: 8px; margin: 0; }
    .expire { font-size: 12px; color: #887e8d; margin-top: 10px; margin-bottom: 0; }
    .footer { margin-top: 32px; font-size: 11px; color: #69606d; text-align: center; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <h1>Reset your password</h1>
      <p>Hello${username ? ` <strong>${escapeHtml(username)}</strong>` : ''},<br>Use this 6-digit code in Native Client to choose a new password:</p>

      <div class="code-box">
        <div class="code">${escapeHtml(code)}</div>
        <div class="expire">Expires in 15 minutes</div>
      </div>

      <p style="font-size: 12px; color: #807685; margin: 0;">If you didn't ask to reset your password, you can safely ignore this email. Your password will stay the same.</p>
    </div>
    <div class="footer">
      Native Client &bull; Native Security<br>
      ${FOOTER_ADDRESS}
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to: email, subject, html, text });
}

module.exports = { resolveResendKey, sendEmail, sendVerificationCodeEmail, sendPasswordResetEmail, DEFAULT_SENDER, REPLY_TO, FOOTER_ADDRESS };
