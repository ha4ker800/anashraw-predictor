// ╔══════════════════════════════════════════════════════════════╗
// ║  ANASHRAW WINGO AI — Cloudflare Worker v10 ULTRA             ║
// ║  Master Backend: Collector + Prediction Engine + AI Proxy    ║
// ║  Author: ANASHRAW DIXIT                                      ║
// ╚══════════════════════════════════════════════════════════════╝

// ── CONFIG ────────────────────────────────────────────────────
const FIREBASE_PROJECT = 'anashrawwingokey';
const FIREBASE_API_KEY = 'AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
const GROQ_API_KEY = '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';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const WINGO_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=';
const DEFAULT_MAX = 500;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;

const FB = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const rateLimitMap = new Map();

// ═══════════════════════════════════════════════════════════════
// CORS & RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// FIREBASE HELPERS
// ═══════════════════════════════════════════════════════════════
async function fbGet(path) {
  try {
    const r = await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fbRunQuery(structuredQuery) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    if (!r.ok) return [];
    const json = await r.json();
    return json.filter(x => x.document).map(x => ({
      id: x.document.name.split('/').pop(),
      ...parseDoc(x.document.fields)
    }));
  } catch { return []; }
}

function parseDoc(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = parseVal(v);
  }
  return out;
}

function parseVal(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(i => parseVal(i));
  if (v.mapValue !== undefined) return parseDoc(v.mapValue.fields);
  return null;
}

function toFields(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toVal(v);
  }
  return fields;
}

function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

async function fbSet(path, data) {
  try {
    const r = await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFields(data) })
    });
    return r.ok;
  } catch { return false; }
}

async function fbExists(path) {
  try {
    const r = await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`);
    return r.ok;
  } catch { return false; }
}

async function fbDelete(path) {
  try {
    const r = await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}

async function queryCollection(collectionId, orderField, direction, limit) {
  return fbRunQuery({
    from: [{ collectionId }],
    orderBy: [{ field: { fieldPath: orderField }, direction }],
    limit
  });
}

// ═══════════════════════════════════════════════════════════════
// GAME HELPERS
// ═══════════════════════════════════════════════════════════════
function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

// ═══════════════════════════════════════════════════════════════
// WINGO FETCH
// ═══════════════════════════════════════════════════════════════
async function fetchWinGo() {
  const urls = [
    WINGO_URL + Date.now(),
    `https://api.allorigins.win/raw?url=${encodeURIComponent(WINGO_URL + Date.now())}`
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, */*',
          'Referer': 'https://draw.ar-lottery01.com/',
          'Origin': 'https://draw.ar-lottery01.com'
        }
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.trim().startsWith('<')) continue;
      const json = JSON.parse(text);
      let list = [];
      if (json.data?.list) list = json.data.list;
      else if (json.data && Array.isArray(json.data)) list = json.data;
      else if (Array.isArray(json)) list = json;
      else if (json.list) list = json.list;
      else {
        for (const k of Object.keys(json || {})) {
          if (Array.isArray(json[k]) && json[k].length) { list = json[k]; break; }
          if (json[k] && typeof json[k] === 'object') {
            for (const k2 of Object.keys(json[k] || {})) {
              if (Array.isArray(json[k][k2]) && json[k][k2].length) { list = json[k][k2]; break; }
            }
            if (list.length) break;
          }
        }
      }
      if (!list.length) continue;
      const norm = list.map(item => {
        const num = parseInt(item.openNum ?? item.number ?? item.num ?? '99');
        const periodStr = String(item.issue ?? item.issueNumber ?? item.period ?? item.id ?? '0');
        const period = parseInt(periodStr) || 0;
        let col = String(item.colour ?? item.color ?? '').toLowerCase();
        if (!col) col = colorOf(num);
        let bs = String(item.bigSmall ?? item.BigSmall ?? '').toUpperCase();
        if (!bs) bs = sizeOf(num);
        return { period, periodStr, number: num, colour: col, bigSmall: bs };
      }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);
      if (norm.length) return norm;
    } catch { continue; }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 🧠 ADVANCED PREDICTION ENGINE — 11-MODEL ENSEMBLE
// ═══════════════════════════════════════════════════════════════
function advancedPredict(data) {
  if (!data || data.length < 5) return null;
  const nums = data.map(d => d.number);
  const colors = data.map(d => String(d.colour).toLowerCase());
  const sizes = data.map(d => String(d.bigSmall).toUpperCase());
  const n = nums.length;

  // 1. Frequency Analysis
  const freqAll = Array(10).fill(0);
  nums.forEach(x => freqAll[x]++);

  // 2. Exponential Weighted Frequency
  const freqWeighted = Array(10).fill(0);
  nums.forEach((x, i) => {
    freqWeighted[x] += Math.exp((i - n) / 15);
  });

  // 3. Markov Chains — Order 1, 2, 3
  const m1 = {}, m2 = {}, m3 = {};
  for (let i = 0; i < n - 1; i++) {
    const s1 = String(nums[i]);
    if (!m1[s1]) m1[s1] = {};
    m1[s1][nums[i+1]] = (m1[s1][nums[i+1]] || 0) + 1;
  }
  for (let i = 0; i < n - 2; i++) {
    const s2 = `${nums[i]},${nums[i+1]}`;
    if (!m2[s2]) m2[s2] = {};
    m2[s2][nums[i+2]] = (m2[s2][nums[i+2]] || 0) + 1;
  }
  for (let i = 0; i < n - 3; i++) {
    const s3 = `${nums[i]},${nums[i+1]},${nums[i+2]}`;
    if (!m3[s3]) m3[s3] = {};
    m3[s3][nums[i+3]] = (m3[s3][nums[i+3]] || 0) + 1;
  }

  const m1S = Array(10).fill(0), m2S = Array(10).fill(0), m3S = Array(10).fill(0);
  if (n >= 1) {
    const s = String(nums[n-1]);
    if (m1[s]) { const t = Object.values(m1[s]).reduce((a,b)=>a+b,0); Object.entries(m1[s]).forEach(([k,v])=>m1S[k]+=(v/t)*100); }
  }
  if (n >= 2) {
    const s = `${nums[n-2]},${nums[n-1]}`;
    if (m2[s]) { const t = Object.values(m2[s]).reduce((a,b)=>a+b,0); Object.entries(m2[s]).forEach(([k,v])=>m2S[k]+=(v/t)*100); }
  }
  if (n >= 3) {
    const s = `${nums[n-3]},${nums[n-2]},${nums[n-1]}`;
    if (m3[s]) { const t = Object.values(m3[s]).reduce((a,b)=>a+b,0); Object.entries(m3[s]).forEach(([k,v])=>m3S[k]+=(v/t)*100); }
  }

  // 4. Gap Analysis
  const lastSeen = Array(10).fill(-1);
  nums.forEach((x, i) => lastSeen[x] = i);
  const expectedGap = n / 10;
  const gapS = Array(10).fill(0);
  lastSeen.forEach((ls, num) => {
    const gap = ls === -1 ? n : n - 1 - ls;
    if (gap > expectedGap) gapS[num] = Math.min(50, (gap - expectedGap) * 3);
  });

  // 5. Streak Detection
  let sNum = nums[n-1], sLen = 1;
  for (let i = n-2; i >= 0; i--) { if (nums[i] === sNum) sLen++; else break; }
  let cColor = colors[n-1], cLen = 1;
  for (let i = n-2; i >= 0; i--) { if (colors[i] === cColor) cLen++; else break; }
  let bsBS = sizes[n-1], bsLen = 1;
  for (let i = n-2; i >= 0; i--) { if (sizes[i] === bsBS) bsLen++; else break; }

  // 6. Window Analysis
  const w10 = nums.slice(-10), w20 = nums.slice(-20);
  const w10F = Array(10).fill(0); w10.forEach(x => w10F[x]++);
  const w20F = Array(10).fill(0); w20.forEach(x => w20F[x]++);
  const big10 = w10.filter(x => x >= 5).length;
  const big20 = w20.filter(x => x >= 5).length;

  // 7. Fibonacci Pattern
  const fibS = Array(10).fill(0);
  for (let i = 2; i < Math.min(n, 50); i++) {
    if (nums[i] === (nums[i-1] + nums[i-2]) % 10) {
      fibS[(nums[i-1] + nums[i]) % 10] += 8;
    }
  }

  // 8. Cycle Detection (5–20 period cycles)
  const cycleS = Array(10).fill(0);
  for (let c = 5; c <= 20; c++) {
    if (n > c) cycleS[nums[n-c]] += 5;
  }

  // 9. Diversity Boost
  const divS = Array(10).fill(0);
  const last5 = new Set(nums.slice(-5)), last10 = new Set(nums.slice(-10));
  for (let i = 0; i < 10; i++) {
    if (!last5.has(i)) divS[i] += 6;
    if (!last10.has(i)) divS[i] += 4;
  }

  // 10. Color frequency balance
  const colF20 = { green: 0, red: 0, violet: 0 };
  colors.slice(-20).forEach(c => {
    if (c.includes('green')) colF20.green++;
    else if (c.includes('violet')) colF20.violet++;
    else colF20.red++;
  });

  // 11. Anti-pattern (numbers that never follow current)
  const antiS = Array(10).fill(0);
  if (n >= 2) {
    const prev = nums[n-1];
    const followCounts = Array(10).fill(0);
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
      if (nums[i] === prev) { followCounts[nums[i+1]]++; total++; }
    }
    if (total > 5) {
      followCounts.forEach((cnt, num) => {
        antiS[num] = (cnt / total) * 30;
      });
    }
  }

  // ── MULTI-MODEL VOTING (weighted ensemble) ────────────────
  const votes = Array(10).fill(0);
  const norm = (arr, w) => {
    const mx = Math.max(...arr) || 1;
    arr.forEach((v, i) => votes[i] += (v / mx) * w);
  };

  norm(freqAll, 8);
  norm(freqWeighted, 18);
  norm(m1S, 12);
  norm(m2S, 18);
  norm(m3S, 22);
  norm(gapS, 12);
  norm(w10F, 14);
  norm(w20F, 10);
  norm(fibS, 7);
  norm(cycleS, 7);
  norm(divS, 10);
  norm(antiS, 16);

  // ── STREAK PENALTIES ─────────────────────────────────────
  if (sLen >= 2) votes[sNum] -= sLen * 8;
  if (sLen >= 4) votes[sNum] -= 20;

  // ── COLOR STREAK BOOST ───────────────────────────────────
  if (cLen >= 3) {
    const oppColors = cColor.includes('green') ? ['red','violet']
      : cColor.includes('violet') ? ['green','red'] : ['green','violet'];
    for (let i = 0; i < 10; i++) {
      if (oppColors.includes(colorOf(i))) votes[i] += cLen * 5;
    }
  }

  // ── BIG/SMALL REBALANCE ──────────────────────────────────
  if (big10 >= 8) for (let i = 0; i < 5; i++) votes[i] += 15;
  if (big10 <= 2) for (let i = 5; i <= 9; i++) votes[i] += 15;
  if (big20 >= 15) for (let i = 0; i < 5; i++) votes[i] += 10;
  if (big20 <= 5) for (let i = 5; i <= 9; i++) votes[i] += 10;

  // ── COLOR IMBALANCE ──────────────────────────────────────
  if (colF20.red >= 12) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'red') votes[i] += 8; }
  if (colF20.green >= 12) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'green') votes[i] += 8; }

  // ── COMPUTE PROBABILITIES ─────────────────────────────────
  const minV = Math.min(...votes);
  const adj = votes.map(v => v - minV + 1);
  const total = adj.reduce((a, b) => a + b, 0);
  const probs = adj.map(v => Math.round((v / total) * 100));

  const best = probs.indexOf(Math.max(...probs));
  const sorted = probs.map((p, i) => ({ n: i, p })).sort((a, b) => b.p - a.p);
  const alternatives = sorted.filter(x => x.n !== best).slice(0, 4).map(a => ({
    number: a.n, color: colorOf(a.n), bigSmall: sizeOf(a.n), pct: a.p
  }));

  // ── CONFIDENCE SCORES ────────────────────────────────────
  const gap2 = probs[best] - sorted[1].p;
  const dataBonus = n >= 400 ? 18 : n >= 300 ? 14 : n >= 200 ? 10 : n >= 100 ? 6 : n >= 50 ? 3 : 0;
  const markovBonus = m3S[best] > 50 ? 12 : m3S[best] > 20 ? 6 : 0;
  const numConf = Math.min(92, Math.max(30, 32 + gap2 * 2 + dataBonus + markovBonus));

  const predColor = colorOf(best);
  let colorConf = 40;
  if (cLen >= 5) colorConf = 80;
  else if (cLen >= 4) colorConf = 72;
  else if (cLen >= 3) colorConf = 63;
  else if (cLen >= 2) colorConf = 52;
  const myCC = colF20[predColor] || 0;
  if (myCC <= 4) colorConf += 8;
  else if (myCC >= 14) colorConf -= 10;
  colorConf = Math.min(90, Math.max(30, Math.round(colorConf)));

  const bsImb10 = Math.abs(big10 - 5);
  const bsImb20 = Math.abs(big20 - 10);
  let bsConf = 36 + bsImb10 * 4 + bsImb20 * 1.5 + dataBonus * 0.8;
  if (bsLen >= 4) bsConf = Math.max(bsConf, 72);
  bsConf = Math.min(90, Math.max(30, Math.round(bsConf)));

  // ── HOT/COLD ──────────────────────────────────────────────
  const freqSorted = [...freqAll.map((f, i) => ({ n: i, f }))].sort((a, b) => b.f - a.f);
  const hot = freqSorted.slice(0, 3).map(x => x.n);
  const cold = freqSorted.slice(-3).map(x => x.n);

  // ── REASONING ────────────────────────────────────────────
  const reasons = [];
  if (sLen >= 2) reasons.push(`#${sNum} ran ${sLen}x (mean reversion)`);
  if (cLen >= 3) reasons.push(`${cColor} streak ${cLen}x (color switch likely)`);
  if (big10 >= 8) reasons.push(`Big/Small imbalance: ${big10}/10 Big (Small overdue)`);
  if (big10 <= 2) reasons.push(`Big/Small imbalance: ${big10}/10 Big (Big overdue)`);
  if (gapS[best] > 15) reasons.push(`#${best} overdue by ${Math.round(n-1-lastSeen[best])} periods`);
  if (m3S[best] > 40) reasons.push(`Markov-3: strong sequence leads to #${best}`);
  if (divS[best] > 0) reasons.push(`#${best} absent from recent results`);
  reasons.push(`11-model ensemble: ${n} records analyzed`);

  return {
    predictedNum: best,
    predictedColor: predColor,
    predictedBS: sizeOf(best),
    numConf: Math.round(numConf),
    colorConf,
    bsConf,
    alternatives,
    reasoning: reasons.slice(0, 3).join('. ') + '.',
    hot,
    cold,
    streakNum: sNum,
    streakLen: sLen,
    colorStreakColor: cColor,
    colorStreakLen: cLen,
    bigCount10: big10,
    dataPoints: n
  };
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
async function getGlobalSettings() {
  const doc = await fbGet('settings/global');
  const f = doc?.fields ? parseDoc(doc.fields) : {};
  return {
    maxResults: f.maxResults || DEFAULT_MAX,
    questionsPerDay: f.questionsPerDay || 5,
    premiumLockMode: f.premiumLockMode || false,
    maintenanceMode: f.maintenanceMode || false,
    maintenanceMessage: f.maintenanceMessage || 'System maintenance in progress.',
  };
}

// ═══════════════════════════════════════════════════════════════
// TRIM
// ═══════════════════════════════════════════════════════════════
async function trimResults(maxResults) {
  const docs = await fbRunQuery({
    from: [{ collectionId: 'results' }],
    select: { fields: [{ fieldPath: '__name__' }, { fieldPath: 'period' }] },
    orderBy: [{ field: { fieldPath: 'period' }, direction: 'ASCENDING' }],
    limit: 2000
  });
  if (docs.length <= maxResults) return { trimmed: 0, total: docs.length };
  const toDelete = docs.length - maxResults;
  const oldest = docs.slice(0, toDelete);
  let deleted = 0;
  for (const doc of oldest) {
    const ok = await fbDelete(`results/${doc.id}`);
    if (ok) deleted++;
  }
  return { trimmed: deleted, total: docs.length - deleted };
}

// ═══════════════════════════════════════════════════════════════
// KEY VALIDATION
// ═══════════════════════════════════════════════════════════════
async function validateKey(key) {
  if (!key) return { ok: false, msg: 'No key provided' };
  try {
    const docs = await fbRunQuery({
      from: [{ collectionId: 'keys' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'key' },
          op: 'EQUAL',
          value: { stringValue: key.toUpperCase() }
        }
      },
      limit: 1
    });
    if (!docs.length) return { ok: false, msg: 'Invalid key' };
    const data = docs[0];
    const docId = data.id;
    if (data.status === 'blocked' || data.blocked === true) return { ok: false, msg: 'Key blocked' };
    if (data.kicked === true) return { ok: false, msg: 'Session kicked' };
    if (data.expiresAt && !data.lifetime) {
      const exp = new Date(data.expiresAt);
      if (exp < new Date()) return { ok: false, msg: 'Key expired' };
    }
    return { ok: true, docId, data };
  } catch (e) {
    return { ok: false, msg: 'Validation error' };
  }
}

// ═══════════════════════════════════════════════════════════════
// QUOTA
// ═══════════════════════════════════════════════════════════════
async function checkAndIncrementQuota(key, keyData, settings) {
  const today = new Date().toISOString().split('T')[0];
  const quotaId = `${key}_${today}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const maxQ = (keyData.questionsOverride !== null && keyData.questionsOverride !== undefined)
    ? parseInt(keyData.questionsOverride)
    : parseInt(settings.questionsPerDay || 5);

  const quotaDoc = await fbGet(`quota/${quotaId}`);
  const used = quotaDoc?.fields?.used?.integerValue ? parseInt(quotaDoc.fields.used.integerValue) : 0;
  if (used >= maxQ) return { ok: false, remaining: 0, max: maxQ, used };
  await fbSet(`quota/${quotaId}`, { used: used + 1, date: today, key });
  return { ok: true, remaining: maxQ - used - 1, max: maxQ, used: used + 1 };
}

// ═══════════════════════════════════════════════════════════════
// COLLECTOR
// ═══════════════════════════════════════════════════════════════
async function runCollector() {
  const logs = [];
  const lg = m => { logs.push(m); console.log(m); };
  lg('=== ANASHRAW COLLECTOR v10 === ' + new Date().toISOString());

  const settings = await getGlobalSettings();
  const MAX = settings.maxResults;

  const norm = await fetchWinGo();
  if (!norm?.length) {
    await fbSet('meta/collector', { lastRun: new Date().toISOString(), status: 'fetch_failed' });
    return { success: false, message: 'WinGo fetch failed', logs };
  }

  const latestPeriod = norm[0].period;
  lg(`Fetched ${norm.length} items. Latest: ${latestPeriod}`);

  const metaDoc = await fbGet('meta/latest');
  const metaFields = metaDoc?.fields ? parseDoc(metaDoc.fields) : {};
  const storedPeriod = metaFields.period || 0;

  let added = 0;
  const isNew = String(latestPeriod) !== String(storedPeriod);

  if (isNew) {
    lg(`New period: ${storedPeriod} → ${latestPeriod}`);
    for (const r of norm) {
      const exists = await fbExists(`results/${r.period}`);
      if (!exists) {
        const ok = await fbSet(`results/${r.period}`, {
          period: r.period,
          periodStr: r.periodStr,
          number: r.number,
          colour: r.colour,
          bigSmall: r.bigSmall,
          savedAt: new Date().toISOString()
        });
        if (ok) added++;
      }
    }
    lg(`Saved ${added} new results`);

    await fbSet('meta/latest', {
      period: latestPeriod,
      periodStr: norm[0].periodStr,
      number: norm[0].number,
      colour: norm[0].colour,
      bigSmall: norm[0].bigSmall,
      updatedAt: new Date().toISOString()
    });
  }

  if (isNew && added > 0) {
    const history = await queryCollection('results', 'period', 'DESCENDING', 500);
    const seq = [...history].reverse();
    if (seq.length >= 10) {
      const pred = advancedPredict(seq);
      if (pred) {
        const nextPeriod = latestPeriod + 1;
        const predData = {
          period: String(nextPeriod),
          forPeriod: String(latestPeriod),
          predictedNum: pred.predictedNum,
          predictedColor: pred.predictedColor,
          predictedBS: pred.predictedBS,
          numConf: pred.numConf,
          colorConf: pred.colorConf,
          bsConf: pred.bsConf,
          alternatives: JSON.stringify(pred.alternatives),
          reasoning: pred.reasoning,
          hot: pred.hot.join(','),
          cold: pred.cold.join(','),
          dataPoints: pred.dataPoints,
          streakNum: pred.streakNum,
          streakLen: pred.streakLen,
          colorStreakColor: pred.colorStreakColor,
          colorStreakLen: pred.colorStreakLen,
          bigCount10: pred.bigCount10,
          createdAt: new Date().toISOString(),
          actualNum: -1,
          actualColor: '',
          actualBS: '',
          winNum: false,
          winColor: false,
          winBS: false,
          anyWin: false,
          resolved: false
        };
        await fbSet(`predictions/${String(nextPeriod)}`, predData);
        await fbSet('meta/latestPrediction', {
          period: String(nextPeriod),
          predictedNum: pred.predictedNum,
          predictedColor: pred.predictedColor,
          predictedBS: pred.predictedBS,
          numConf: pred.numConf,
          colorConf: pred.colorConf,
          bsConf: pred.bsConf,
          reasoning: pred.reasoning,
          hot: pred.hot.join(','),
          cold: pred.cold.join(','),
          dataPoints: pred.dataPoints,
          createdAt: new Date().toISOString()
        });
        lg(`Prediction saved: #${pred.predictedNum} ${pred.predictedColor} ${pred.predictedBS}`);
      }
    }
  }

  const trimResult = await trimResults(MAX);
  if (trimResult.trimmed > 0) lg(`Trimmed ${trimResult.trimmed} old results`);

  await fbSet('meta/collector', {
    lastRun: new Date().toISOString(),
    status: 'ok',
    added,
    latestPeriod: String(latestPeriod),
    isNew
  });

  return {
    success: true,
    message: `Added:${added}. Latest:${latestPeriod}. Trimmed:${trimResult.trimmed || 0}`,
    logs
  };
}

// ═══════════════════════════════════════════════════════════════
// AI CHAT HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleAIChat(request) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const { key, message, history: chatHistory } = body;
  if (!key || !message) return jsonResp({ error: 'key and message required' }, 400);

  const keyResult = await validateKey(key);
  if (!keyResult.ok) return jsonResp({ error: keyResult.msg, code: 'KEY_INVALID' }, 401);

  const settings = await getGlobalSettings();
  if (settings.maintenanceMode) return jsonResp({ error: settings.maintenanceMessage, code: 'MAINTENANCE' }, 503);

  const quota = await checkAndIncrementQuota(key.toUpperCase(), keyResult.data, settings);
  if (!quota.ok) return jsonResp({ error: 'Daily quota exhausted', code: 'QUOTA_EXHAUSTED', remaining: 0, max: quota.max }, 429);

  const recentResults = await queryCollection('results', 'period', 'DESCENDING', 20);
  const resultContext = recentResults.map(r =>
    `Period ${r.periodStr || r.period}: №${r.number} | ${r.colour} | ${r.bigSmall}`
  ).join('\n');

  const latestPredDoc = await fbGet('meta/latestPrediction');
  const lp = latestPredDoc?.fields ? parseDoc(latestPredDoc.fields) : null;
  const predContext = lp
    ? `Latest Prediction for period ${lp.period}: №${lp.predictedNum} | ${lp.predictedColor} | ${lp.predictedBS} (Num:${lp.numConf}% Color:${lp.colorConf}% B/S:${lp.bsConf}%)`
    : 'No prediction available';

  const systemPrompt = `You are ANASHRAW WINGO AI, an expert WinGo 1-minute game pattern analyst.

LIVE DATA (last 20 results, newest first):
${resultContext}

${predContext}

GAME RULES:
- Numbers: 0-9
- 0,5 = Violet | 1,3,7,9 = Green | 2,4,6,8 = Red
- 0-4 = SMALL | 5-9 = BIG

INSTRUCTIONS:
- Reply in the same language as the user (Hindi/English/Hinglish)
- Be concise and analytical
- Never guarantee wins — this is statistical pattern analysis only
- Keep responses under 200 words`;

  const messages = [{ role: 'system', content: systemPrompt }];
  if (chatHistory?.length) {
    messages.push(...chatHistory.slice(-8).map(m => ({ role: m.role, content: m.content })));
  }
  messages.push({ role: 'user', content: message });

  try {
    const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 400, temperature: 0.7 })
    });
    if (!groqResp.ok) {
      const err = await groqResp.text();
      return jsonResp({ error: 'AI service error', details: err }, 502);
    }
    const groqData = await groqResp.json();
    const reply = groqData.choices?.[0]?.message?.content || 'Sorry, no response from AI.';
    await fbSet(`keys/${keyResult.docId}`, { lastUsed: new Date().toISOString() });
    return jsonResp({ reply, remaining: quota.remaining, max: quota.max, used: quota.used });
  } catch (e) {
    return jsonResp({ error: 'AI request failed: ' + e.message }, 502);
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORT DEFAULT
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(ip)) {
      return jsonResp({ error: 'Rate limit exceeded. Max 30 req/min.' }, 429);
    }

    // ── Routes ──
    if (path === '/ai-chat' && request.method === 'POST') return handleAIChat(request);

    if (path === '/prediction' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (key) {
        const kv = await validateKey(key);
        if (!kv.ok) return jsonResp({ error: kv.msg }, 401);
      }
      const doc = await fbGet('meta/latestPrediction');
      if (!doc?.fields) return jsonResp({ error: 'No prediction yet' }, 404);
      return jsonResp({ prediction: parseDoc(doc.fields) });
    }

    if (path === '/results' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
      const results = await queryCollection('results', 'period', 'DESCENDING', limit);
      return jsonResp({ results, count: results.length });
    }

    if (path === '/quota' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return jsonResp({ error: 'key required' }, 400);
      const kv = await validateKey(key);
      if (!kv.ok) return jsonResp({ error: kv.msg }, 401);
      const settings = await getGlobalSettings();
      const today = new Date().toISOString().split('T')[0];
      const quotaId = `${key.toUpperCase()}_${today}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const qDoc = await fbGet(`quota/${quotaId}`);
      const used = qDoc?.fields?.used?.integerValue ? parseInt(qDoc.fields.used.integerValue) : 0;
      const maxQ = (kv.data.questionsOverride != null) ? parseInt(kv.data.questionsOverride) : parseInt(settings.questionsPerDay || 5);
      return jsonResp({
        used, max: maxQ, remaining: Math.max(0, maxQ - used),
        tier: kv.data.tier || 'basic',
        confidenceMode: kv.data.confidenceMode || 'normal',
        label: kv.data.label || '',
        lifetime: kv.data.lifetime || false,
        expiresAt: kv.data.expiresAt || null
      });
    }

    if (path === '/settings' && request.method === 'GET') {
      const settings = await getGlobalSettings();
      const payDoc = await fbGet('settings/payment');
      const pay = payDoc?.fields ? parseDoc(payDoc.fields) : {};
      return jsonResp({ global: settings, payment: pay });
    }

    if (path === '/collect' && request.method === 'GET') {
      const result = await runCollector();
      return jsonResp(result);
    }

    if (path === '/health') {
      const collMeta = await fbGet('meta/collector');
      const latestMeta = await fbGet('meta/latest');
      const settings = await getGlobalSettings();
      return jsonResp({
        status: 'ok',
        version: 'v10-ULTRA',
        collector: collMeta?.fields ? parseDoc(collMeta.fields) : null,
        latest: latestMeta?.fields ? parseDoc(latestMeta.fields) : null,
        settings
      });
    }

    return jsonResp({
      name: 'ANASHRAW WINGO AI Worker v10-ULTRA',
      routes: ['/ai-chat [POST]', '/prediction [GET]', '/results [GET]', '/quota [GET]', '/settings [GET]', '/collect [GET]', '/health [GET]'],
      author: 'ANASHRAW DIXIT'
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCollector());
  }
};
      select: { fields: [{ fieldPath: '__name__' }, { fieldPath: 'period' }] },
      orderBy: [{ field: { fieldPath: 'period' }, direction: 'ASCENDING' }],
      limit: 2000
    }
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) return [];
    const json = await r.json();
    return json
      .filter(x => x.document)
      .map(x => ({
        name: x.document.name,
        period: x.document.fields?.period?.stringValue || ''
      }));
  } catch (e) {
    return [];
  }
}

async function trimIfNeeded(maxResults) {
  const docs = await getAllDocsSorted();
  const count = docs.length;
  if (count <= maxResults) return { trimmed: 0, total: count };
  const toDelete = count - maxResults;
  const oldest = docs.slice(0, toDelete);
  let deleted = 0;
  for (const doc of oldest) {
    const docId = doc.name.split('/').pop();
    const ok = await fbDelete(`results/${docId}`);
    if (ok) deleted++;
  }
  return { trimmed: deleted, total: count - deleted };
}

async function runCollector() {
  console.log('=== WinGo Collector v5 FIXED ===');
  console.log(new Date().toISOString());

  const MAX_RESULTS = await getMaxResults();
  console.log(`Max results limit: ${MAX_RESULTS}`);

  const norm = await fetchWinGo();
  if (!norm || !norm.length) {
    return { success: false, message: 'Fetch failed' };
  }

  const latestPeriod = norm[0].period;
  console.log(`Fetched ${norm.length}. Latest: ${latestPeriod}`);

  const metaDoc = await fbGet('meta/latest');
  const storedPeriod = metaDoc?.fields?.period?.stringValue || '';

  if (latestPeriod === storedPeriod) {
    const trimResult = await trimIfNeeded(MAX_RESULTS);
    return {
      success: true,
      message: `No new data. Trimmed:${trimResult.trimmed}. Total:${trimResult.total}. Max:${MAX_RESULTS}`
    };
  }

  console.log(`New period: ${storedPeriod} → ${latestPeriod}`);

  let added = 0;
  for (const r of norm) {
    const exists = await fbExists(`results/${r.period}`);
    if (!exists) {
      const ok = await fbSet(`results/${r.period}`, {
        period: r.period,
        number: r.number,
        colour: r.colour,
        bigSmall: r.bigSmall,
        savedAt: new Date().toISOString()
      });
      if (ok) added++;
    }
  }
  console.log(`Added ${added}`);

  await fbSet('meta/latest', {
    period: latestPeriod,
    number: norm[0].number,
    colour: norm[0].colour,
    bigSmall: norm[0].bigSmall,
    updatedAt: new Date().toISOString()
  });

  const trimResult = await trimIfNeeded(MAX_RESULTS);

  return {
    success: true,
    message: `Added:${added}. Trimmed:${trimResult.trimmed}. Total:${trimResult.total}. Max:${MAX_RESULTS}. Latest:${latestPeriod}`
  };
}

export default {
  async fetch(request, env, ctx) {
    const result = await runCollector();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  async scheduled(event, env, ctx) {
    await runCollector();
  }
};
