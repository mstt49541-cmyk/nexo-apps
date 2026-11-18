const crypto = require('crypto');

let cachedToken = null;
let cachedTokenExp = 0;

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getGoogleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExp - 60) {
    return cachedToken;
  }

  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope:
        'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  );

  const signInput = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();
  const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
  const signature = base64Url(signer.sign(privateKey));
  const jwt = `${signInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth token failed: ${errText}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExp = now + Number(data.expires_in || 3600);
  return cachedToken;
}

function normalizePhoneVariants(phone) {
  const raw = String(phone || '').trim();
  if (!raw || raw.toUpperCase() === 'ALL') return [];
  const digits = raw.replace(/\D/g, '');
  const set = new Set([raw.toLowerCase()]);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    set.add('0' + last10);
    set.add('880' + last10);
    set.add('+880' + last10);
    set.add(digits);
  }
  return Array.from(set);
}

function readFsString(field) {
  return field && typeof field.stringValue === 'string' ? field.stringValue : '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const sa = getServiceAccount();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: !!sa,
      projectId: sa ? sa.project_id : null,
      message: sa
        ? 'NEXO Push Server is active and ready.'
        : 'Set FIREBASE_SERVICE_ACCOUNT in Vercel Environment Variables.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!sa) {
    return res.status(503).json({
      ok: false,
      error: 'FIREBASE_SERVICE_ACCOUNT env variable is not configured.',
    });
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const targetPhone = String(payload.targetPhone || '').trim();
    const targetEmail = String(payload.targetEmail || '').trim().toLowerCase();
    const targetApp = String(payload.targetApp || 'all').trim().toLowerCase();
    const title = String(payload.title || 'NEXO Alert').slice(0, 120);
    const body = String(payload.body || 'You have a new update.').slice(0, 500);
    const excludeToken = String(payload.excludeToken || '');
    const explicitTokens = Array.isArray(payload.tokens) ? payload.tokens : [];

    const accessToken = await getGoogleAccessToken(sa);
    const projectId = sa.project_id;

    const fsRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/fcmTokens?pageSize=300`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const tokenEntries = [];
    if (fsRes.ok) {
      const fsData = await fsRes.json();
      const docs = Array.isArray(fsData.documents) ? fsData.documents : [];
      const phoneVariants = normalizePhoneVariants(targetPhone);
      const isBroadcast = targetPhone.toUpperCase() === 'ALL';

      for (const doc of docs) {
        const f = doc.fields || {};
        const tok = readFsString(f.token);
        if (!tok || tok === excludeToken) continue;

        const docApp = readFsString(f.app).toLowerCase() || 'pay';
        const docEmail = readFsString(f.email).toLowerCase();
        const docPhone = readFsString(f.phone);
        const docPhoneVariants = normalizePhoneVariants(docPhone);

        if (targetApp !== 'all' && docApp !== targetApp) continue;

        let matched = false;
        if (isBroadcast) {
          matched = true;
        } else {
          if (targetEmail && docEmail && docEmail === targetEmail) matched = true;
          if (
            !matched &&
            phoneVariants.length &&
            docPhoneVariants.some((v) => phoneVariants.includes(v))
          ) {
            matched = true;
          }
          if (!matched && !targetPhone && !targetEmail && targetApp !== 'all') {
            matched = true;
          }
        }

        if (matched) {
          tokenEntries.push({ token: tok, app: docApp, email: docEmail, docName: doc.name });
        }
      }
    }

    for (const t of explicitTokens) {
      if (t && t !== excludeToken) {
        tokenEntries.push({
          token: String(t),
          app: targetApp === 'all' ? 'pay' : targetApp,
          email: '',
          docName: '',
        });
      }
    }

    const uniqueMap = new Map();
    for (const item of tokenEntries) {
      if (!uniqueMap.has(item.token)) uniqueMap.set(item.token, item);
    }
    const targets = Array.from(uniqueMap.values());

    if (targets.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, matched: 0 });
    }

    const colMap = { pay: 'users', business: 'businesses', card: 'cards' };

    const sendResults = await Promise.allSettled(
      targets.map(async (item) => {
        const appKey = item.app || 'pay';
        let finalBody = body;
        if (finalBody.includes('{{BALANCE}}')) {
          let balSnippet = '';
          const col = colMap[appKey];
          if (col && item.email) {
            try {
              const balRes = await fetch(
                `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${col}/${encodeURIComponent(item.email)}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (balRes.ok) {
                const balDoc = await balRes.json();
                const bf = balDoc && balDoc.fields && balDoc.fields.balance;
                const rawVal = bf ? (bf.doubleValue ?? bf.integerValue) : undefined;
                if (rawVal !== undefined && !Number.isNaN(Number(rawVal))) {
                  const formatted = Number(rawVal).toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  });
                  balSnippet = `Balance Tk ${formatted}. `;
                }
              }
            } catch {}
          }
          finalBody = finalBody.replace(/\{\{BALANCE\}\}/g, balSnippet);
        }
        const resFcm = await fetch(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: item.token,
                data: {
                  title,
                  body: finalBody,
                  app: appKey,
                  url: payload.url || `/${appKey}`,
                  icon: `/icons/pwa-${appKey}-192x192.png`,
                  tag: String(payload.tag || `nexo-${appKey}-${Date.now()}`),
                },
                webpush: {
                  headers: {
                    Urgency: 'high',
                    TTL: '86400',
                  },
                  fcm_options: {
                    link: payload.url || `/${appKey}`,
                  },
                },
              },
            }),
          }
        );

        if (!resFcm.ok) {
          const errBody = await resFcm.text();
          if (
            item.docName &&
            (errBody.includes('UNREGISTERED') || errBody.includes('Requested entity was not found'))
          ) {
            fetch(`https://firestore.googleapis.com/v1/${item.docName}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${accessToken}` },
            }).catch(() => {});
          }
          throw new Error(errBody);
        }
        return true;
      })
    );

    const sentCount = sendResults.filter((r) => r.status === 'fulfilled').length;
    return res.status(200).json({ ok: true, sent: sentCount, matched: targets.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Push send failed' });
  }
};
      
