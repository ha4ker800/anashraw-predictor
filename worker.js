// ╔══════════════════════════════════════════════════════════════╗
// ║  ANASHRAW WINGO AI — Cloudflare Worker v12                  ║
// ║  NEW Firebase: newwingoaikey | Enhanced Prediction Engine   ║
// ╚══════════════════════════════════════════════════════════════╝

// ── CONFIG ────────────────────────────────────────────────────
const FIREBASE_PROJECT = 'newwingoaikey';
const FIREBASE_API_KEY = 'AIzaSyBYwuezKZPXU3pcM6hVi2hkD1EWKX9_5B8';
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
  for (const [k, v] of Object.entries(fields)) out[k] = parseVal(v);
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
  for (const [k, v] of Object.entries(data)) fields[k] = toVal(v);
  return fields;
}

function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
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

async function fbArrayUnion(path, fieldName, newItem) {
  try {
    const existing = await fbGet(path);
    const current = existing?.fields?.[fieldName]
      ? parseVal(existing.fields[fieldName])
      : [];
    const arr = Array.isArray(current) ? current : [];
    arr.push(newItem);
    const trimmed = arr.slice(-200);
    const doc = existing?.fields ? parseDoc(existing.fields) : {};
    doc[fieldName] = trimmed;
    doc.lastUpdated = new Date().toISOString();
    return await fbSet(path, doc);
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
// GET GROQ KEY
// ═══════════════════════════════════════════════════════════════
async function getGroqKey() {
  const doc = await fbGet('settings/apiKeys');
  if (!doc?.fields) return null;
  const d = parseDoc(doc.fields);
  return d.groqKey || null;
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
// 🧠 ULTRA PREDICTION ENGINE v12 — 15-MODEL ENSEMBLE
//    Modes: normal | high | vip
//    Logic: Anti-betting psychology + Pattern analysis
// ═══════════════════════════════════════════════════════════════
function advancedPredict(data, mode = 'normal') {
  if (!data || data.length < 5) return null;
  const nums = data.map(d => d.number);
  const colors = data.map(d => String(d.colour).toLowerCase());
  const sizes = data.map(d => String(d.bigSmall).toUpperCase());
  const n = nums.length;

  // ── MODEL 1: Global frequency (all history) ──
  const freqAll = Array(10).fill(0);
  nums.forEach(x => freqAll[x]++);

  // ── MODEL 2: Exponentially weighted frequency ──
  const freqWeighted = Array(10).fill(0);
  nums.forEach((x, i) => { freqWeighted[x] += Math.exp((i - n) / 15); });

  // ── MODEL 3,4,5: Markov chains (order 1,2,3) ──
  const m1 = {}, m2 = {}, m3 = {};
  for (let i = 0; i < n - 1; i++) {
    const s = String(nums[i]);
    if (!m1[s]) m1[s] = {};
    m1[s][nums[i+1]] = (m1[s][nums[i+1]] || 0) + 1;
  }
  for (let i = 0; i < n - 2; i++) {
    const s = `${nums[i]},${nums[i+1]}`;
    if (!m2[s]) m2[s] = {};
    m2[s][nums[i+2]] = (m2[s][nums[i+2]] || 0) + 1;
  }
  for (let i = 0; i < n - 3; i++) {
    const s = `${nums[i]},${nums[i+1]},${nums[i+2]}`;
    if (!m3[s]) m3[s] = {};
    m3[s][nums[i+3]] = (m3[s][nums[i+3]] || 0) + 1;
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

  // ── MODEL 6: Gap/Due analysis ──
  const lastSeen = Array(10).fill(-1);
  nums.forEach((x, i) => lastSeen[x] = i);
  const expectedGap = n / 10;
  const gapS = Array(10).fill(0);
  lastSeen.forEach((ls, num) => {
    const gap = ls === -1 ? n : n - 1 - ls;
    if (gap > expectedGap) gapS[num] = Math.min(50, (gap - expectedGap) * 3);
  });

  // ── MODEL 7,8: Sliding windows (10 & 20) ──
  const w10 = nums.slice(-10), w20 = nums.slice(-20), w5 = nums.slice(-5);
  const w10F = Array(10).fill(0); w10.forEach(x => w10F[x]++);
  const w20F = Array(10).fill(0); w20.forEach(x => w20F[x]++);
  const w5F = Array(10).fill(0); w5.forEach(x => w5F[x]++);
  const big10 = w10.filter(x => x >= 5).length;
  const big20 = w20.filter(x => x >= 5).length;
  const big5 = w5.filter(x => x >= 5).length;

  // ── MODEL 9: Streak detection ──
  let sNum = nums[n-1], sLen = 1;
  for (let i = n-2; i >= 0; i--) { if (nums[i] === sNum) sLen++; else break; }
  let cColor = colors[n-1], cLen = 1;
  for (let i = n-2; i >= 0; i--) { if (colors[i] === cColor) cLen++; else break; }
  let sBS = sizes[n-1], bsLen = 1;
  for (let i = n-2; i >= 0; i--) { if (sizes[i] === sBS) bsLen++; else break; }

  // ── MODEL 10: Fibonacci pattern ──
  const fibS = Array(10).fill(0);
  for (let i = 2; i < Math.min(n, 50); i++) {
    if (nums[i] === (nums[i-1] + nums[i-2]) % 10) fibS[(nums[i-1] + nums[i]) % 10] += 8;
  }

  // ── MODEL 11: Cycle detection ──
  const cycleS = Array(10).fill(0);
  for (let c = 5; c <= 20; c++) { if (n > c) cycleS[nums[n-c]] += 5; }

  // ── MODEL 12: Diversity score ──
  const divS = Array(10).fill(0);
  const last5Set = new Set(w5), last10Set = new Set(w10);
  for (let i = 0; i < 10; i++) {
    if (!last5Set.has(i)) divS[i] += 8;
    if (!last10Set.has(i)) divS[i] += 5;
  }

  // ── MODEL 13: Anti-follow (mean reversion) ──
  const antiS = Array(10).fill(0);
  if (n >= 2) {
    const prev = nums[n-1];
    const followCounts = Array(10).fill(0);
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
      if (nums[i] === prev) { followCounts[nums[i+1]]++; total++; }
    }
    if (total > 5) followCounts.forEach((cnt, num) => { antiS[num] = (cnt / total) * 35; });
  }

  // ── MODEL 14: Color transition matrix ──
  const colTransS = Array(10).fill(0);
  const colTrans = {};
  for (let i = 0; i < n-1; i++) {
    const c = colors[i];
    if (!colTrans[c]) colTrans[c] = { green: 0, red: 0, violet: 0 };
    const nc = colors[i+1];
    if (nc.includes('green')) colTrans[c].green++;
    else if (nc.includes('violet')) colTrans[c].violet++;
    else colTrans[c].red++;
  }
  if (colTrans[cColor]) {
    const ct = colTrans[cColor];
    const total = ct.green + ct.red + ct.violet || 1;
    for (let i = 0; i < 10; i++) {
      const c = colorOf(i);
      if (c === 'green') colTransS[i] += (ct.green / total) * 40;
      else if (c === 'red') colTransS[i] += (ct.red / total) * 40;
      else colTransS[i] += (ct.violet / total) * 40;
    }
  }

  // ── MODEL 15: ANTI-BETTING PSYCHOLOGY MODEL ──
  // Jis number/color pe jyada betting hogi, woh NAHI aayega
  // High-volume numbers = most recently repeated = sab bet kar rahe hain
  const antiBetS = Array(10).fill(0);
  // Jo numbers baar baar aa rahe hain, unpe log bet karte hain — unhe penalize karo
  const recentFreq = Array(10).fill(0);
  nums.slice(-30).forEach(x => recentFreq[x]++);
  const maxRF = Math.max(...recentFreq) || 1;
  recentFreq.forEach((f, i) => {
    // Jo zyada popular hai (baar aaya), uski probability REDUCE karo
    antiBetS[i] = ((maxRF - f) / maxRF) * 30;
  });
  // Color betting psychology: jo color recent mein hot hai, log bet karte hain
  const colF10 = { green: 0, red: 0, violet: 0 };
  colors.slice(-10).forEach(c => {
    if (c.includes('green')) colF10.green++;
    else if (c.includes('violet')) colF10.violet++;
    else colF10.red++;
  });
  const colF20 = { green: 0, red: 0, violet: 0 };
  colors.slice(-20).forEach(c => {
    if (c.includes('green')) colF20.green++;
    else if (c.includes('violet')) colF20.violet++;
    else colF20.red++;
  });
  // Agar green zyada aa raha hai, log green pe bet karenge — to NON-green pe boost
  if (colF10.green >= 6) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'green') antiBetS[i] += 15; }
  if (colF10.red >= 6) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'red') antiBetS[i] += 15; }
  if (colF10.violet >= 4) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'violet') antiBetS[i] += 12; }

  // ── VOTE AGGREGATION ──
  const votes = Array(10).fill(0);
  const norm2 = (arr, w) => {
    const mx = Math.max(...arr) || 1;
    arr.forEach((v, i) => votes[i] += (v / mx) * w);
  };

  // Mode-based weights
  if (mode === 'vip') {
    // VIP: Heavy on Markov-3, anti-bet, anti-follow
    norm2(freqAll, 5);       norm2(freqWeighted, 12);
    norm2(m1S, 10);          norm2(m2S, 15);
    norm2(m3S, 28);          norm2(gapS, 10);
    norm2(w10F, 10);         norm2(w20F, 8);
    norm2(fibS, 6);          norm2(cycleS, 6);
    norm2(divS, 10);         norm2(antiS, 22);
    norm2(colTransS, 18);    norm2(antiBetS, 30);  // Anti-bet heavy
    norm2(w5F, 8);
  } else if (mode === 'high') {
    // HIGH: Balanced, strong Markov + anti-bet
    norm2(freqAll, 7);       norm2(freqWeighted, 15);
    norm2(m1S, 12);          norm2(m2S, 18);
    norm2(m3S, 25);          norm2(gapS, 12);
    norm2(w10F, 12);         norm2(w20F, 10);
    norm2(fibS, 7);          norm2(cycleS, 7);
    norm2(divS, 10);         norm2(antiS, 18);
    norm2(colTransS, 14);    norm2(antiBetS, 22);
    norm2(w5F, 8);
  } else {
    // NORMAL: Classic weights
    norm2(freqAll, 8);       norm2(freqWeighted, 18);
    norm2(m1S, 12);          norm2(m2S, 18);
    norm2(m3S, 22);          norm2(gapS, 12);
    norm2(w10F, 14);         norm2(w20F, 10);
    norm2(fibS, 7);          norm2(cycleS, 7);
    norm2(divS, 10);         norm2(antiS, 16);
    norm2(colTransS, 10);    norm2(antiBetS, 15);
    norm2(w5F, 6);
  }

  // ── STREAK PENALTIES & BONUSES ──
  if (sLen >= 2) votes[sNum] -= sLen * 8;
  if (sLen >= 4) votes[sNum] -= 25;
  if (sLen >= 6) votes[sNum] -= 40; // Hard penalty for long streaks
  if (cLen >= 3) {
    const oppColors = cColor.includes('green') ? ['red', 'violet']
      : cColor.includes('violet') ? ['green', 'red'] : ['green', 'violet'];
    for (let i = 0; i < 10; i++) {
      if (oppColors.includes(colorOf(i))) votes[i] += cLen * 6;
    }
  }
  if (bsLen >= 4) {
    // Big/Small streak — opposite is due
    const oppBS = sBS === 'BIG' ? 'SMALL' : 'BIG';
    for (let i = 0; i < 10; i++) {
      if (sizeOf(i) === oppBS) votes[i] += bsLen * 5;
    }
  }
  if (big10 >= 8) for (let i = 0; i < 5; i++) votes[i] += 18;
  if (big10 <= 2) for (let i = 5; i <= 9; i++) votes[i] += 18;
  if (big5 >= 4) for (let i = 0; i < 5; i++) votes[i] += 12;
  if (big5 <= 1) for (let i = 5; i <= 9; i++) votes[i] += 12;
  if (big20 >= 15) for (let i = 0; i < 5; i++) votes[i] += 10;
  if (big20 <= 5) for (let i = 5; i <= 9; i++) votes[i] += 10;
  if (colF20.red >= 12) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'red') votes[i] += 8; }
  if (colF20.green >= 12) for (let i = 0; i < 10; i++) { if (colorOf(i) !== 'green') votes[i] += 8; }

  // ── PROBABILITY CALCULATION ──
  const minV = Math.min(...votes);
  const adj = votes.map(v => v - minV + 1);
  const total = adj.reduce((a, b) => a + b, 0);
  const probs = adj.map(v => Math.round((v / total) * 100));

  const best = probs.indexOf(Math.max(...probs));
  const sorted = probs.map((p, i) => ({ n: i, p })).sort((a, b) => b.p - a.p);
  const alternatives = sorted.filter(x => x.n !== best).slice(0, 4).map(a => ({
    number: a.n,
    colour: colorOf(a.n),
    bigSmall: sizeOf(a.n),
    probability: a.p
  }));

  // ── CONFIDENCE CALCULATION (mode-boosted) ──
  const gap2 = probs[best] - sorted[1].p;
  const dataBonus = n >= 400 ? 18 : n >= 300 ? 14 : n >= 200 ? 10 : n >= 100 ? 6 : n >= 50 ? 3 : 0;
  const modeBonus = mode === 'vip' ? 12 : mode === 'high' ? 7 : 0;
  const markovBonus = m3S[best] > 50 ? 12 : m3S[best] > 20 ? 6 : 0;
  const antiBetBonus = antiBetS[best] > 20 ? 8 : 0;

  let numConf = Math.min(95, Math.max(30, 32 + gap2 * 2 + dataBonus + markovBonus + modeBonus + antiBetBonus));

  const predColor = colorOf(best);
  let colorConf = 42;
  if (cLen >= 5) colorConf = 85;
  else if (cLen >= 4) colorConf = 76;
  else if (cLen >= 3) colorConf = 67;
  else if (cLen >= 2) colorConf = 56;
  const myCC = colF20[predColor] || 0;
  if (myCC <= 4) colorConf += 10;
  else if (myCC >= 14) colorConf -= 10;
  colorConf = Math.min(95, Math.max(30, Math.round(colorConf + modeBonus)));

  const bsImb10 = Math.abs(big10 - 5);
  const bsImb20 = Math.abs(big20 - 10);
  let bsConf = 36 + bsImb10 * 4 + bsImb20 * 1.5 + dataBonus * 0.8 + modeBonus;
  if (sizeOf(best) === (big10 >= 5 ? 'SMALL' : 'BIG')) bsConf = Math.max(bsConf, 75);
  bsConf = Math.min(95, Math.max(30, Math.round(bsConf)));

  const freqSorted = [...freqAll.map((f, i) => ({ n: i, f }))].sort((a, b) => b.f - a.f);
  const hot = freqSorted.slice(0, 3).map(x => x.n);
  const cold = freqSorted.slice(-3).map(x => x.n);

  // ── ANTI-BET REASONING ──
  const reasons = [];
  if (sLen >= 2) reasons.push(`#${sNum} repeated ${sLen}x — mean reversion triggered`);
  if (cLen >= 3) reasons.push(`${cColor} color streak ${cLen}x — switch expected`);
  if (big10 >= 8) reasons.push(`${big10}/10 BIG — SMALL overdue`);
  if (big10 <= 2) reasons.push(`${big10}/10 BIG — BIG overdue`);
  if (gapS[best] > 15) reasons.push(`#${best} overdue by ${Math.round(n-1-lastSeen[best])} periods`);
  if (m3S[best] > 40) reasons.push(`Markov-3 chain: strong signal → #${best}`);
  if (antiBetS[best] > 20) reasons.push(`Anti-bet model: low public volume on #${best}`);
  if (bsLen >= 3) reasons.push(`${sBS} streak ${bsLen}x — ${sBS === 'BIG' ? 'SMALL' : 'BIG'} expected`);
  reasons.push(`15-model ensemble | ${n} records | Mode: ${mode.toUpperCase()}`);

  return {
    predictedNum: best,
    predictedColor: predColor,
    predictedBS: sizeOf(best),
    numConf: Math.round(numConf),
    colorConf,
    bsConf,
    alternatives,
    reasoning: reasons.slice(0, 4).join('. ') + '.',
    hot,
    cold,
    bsRatio: `${big10}/10 BIG`,
    colorRun: cLen >= 3 ? `${cColor.toUpperCase()} x${cLen}` : null,
    streakInfo: sLen >= 2 ? `${sNum} x${sLen}` : null,
    streakNum: sNum,
    streakLen: sLen,
    colorStreakColor: cColor,
    colorStreakLen: cLen,
    bsStreakBS: sBS,
    bsStreakLen: bsLen,
    bigCount10: big10,
    bigCount5: big5,
    dataPoints: n,
    mode,
    antiBetActive: true
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
  lg('=== ANASHRAW COLLECTOR v12 === ' + new Date().toISOString());

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

    // Resolve previous prediction
    const prevPredDoc = await fbGet(`predictions/${String(latestPeriod)}`);
    if (prevPredDoc?.fields) {
      const prev = parseDoc(prevPredDoc.fields);
      if (!prev.resolved) {
        const actualNum = norm[0].number;
        const actualCol = norm[0].colour;
        const actualBS = norm[0].bigSmall;
        const winNum = prev.predictedNum === actualNum;
        const winCol = prev.predictedColor === actualCol;
        const winBS = prev.predictedBS === actualBS;
        await fbSet(`predictions/${String(latestPeriod)}`, {
          ...prev,
          actualNum,
          actualColor: actualCol,
          actualBS,
          winNum,
          winColor: winCol,
          winBS,
          anyWin: winNum || winCol || winBS,
          resolved: true,
          resolvedAt: new Date().toISOString()
        });
        lg(`Resolved prediction P${latestPeriod}: num=${winNum} col=${winCol} bs=${winBS}`);
      }
    }
  }

  if (isNew && added > 0) {
    const history = await queryCollection('results', 'period', 'DESCENDING', 500);
    const seq = [...history].reverse();
    if (seq.length >= 10) {
      // Run prediction for ALL 3 modes, save the one matching key tier
      // We save the 'high' mode by default (vip users get vip in /prediction endpoint)
      const predNormal = advancedPredict(seq, 'normal');
      const predHigh = advancedPredict(seq, 'high');
      const predVip = advancedPredict(seq, 'vip');

      if (predHigh) {
        const nextPeriod = latestPeriod + 1;
        const makePredData = (pred, m) => ({
          period: String(nextPeriod),
          forPeriod: String(latestPeriod),
          number: pred.predictedNum,
          predictedNum: pred.predictedNum,
          colour: pred.predictedColor,
          predictedColor: pred.predictedColor,
          bigSmall: pred.predictedBS,
          predictedBS: pred.predictedBS,
          numberConfidence: pred.numConf,
          numConf: pred.numConf,
          colorConf: pred.colorConf,
          bsConf: pred.bsConf,
          alternatives: pred.alternatives,
          reasoning: pred.reasoning,
          hotNumbers: pred.hot,
          coldNumbers: pred.cold,
          hot: pred.hot,
          cold: pred.cold,
          bsRatio: pred.bsRatio,
          colorRun: pred.colorRun,
          streak: pred.streakInfo,
          streakNum: pred.streakNum,
          streakLen: pred.streakLen,
          colorStreakColor: pred.colorStreakColor,
          colorStreakLen: pred.colorStreakLen,
          bsStreakBS: pred.bsStreakBS,
          bsStreakLen: pred.bsStreakLen,
          bigCount10: pred.bigCount10,
          bigCount5: pred.bigCount5,
          dataPoints: pred.dataPoints,
          mode: m,
          antiBetActive: true,
          createdAt: new Date().toISOString(),
          actualNum: -1,
          actualColor: '',
          actualBS: '',
          winNum: false,
          winColor: false,
          winBS: false,
          anyWin: false,
          resolved: false
        });

        // Save all 3 modes separately
        await fbSet(`predictions/${String(nextPeriod)}`, makePredData(predHigh, 'high'));
        await fbSet(`predictions_vip/${String(nextPeriod)}`, makePredData(predVip, 'vip'));
        await fbSet(`predictions_normal/${String(nextPeriod)}`, makePredData(predNormal, 'normal'));

        // meta/latestPrediction = high (default)
        await fbSet('meta/latestPrediction', makePredData(predHigh, 'high'));
        await fbSet('meta/latestPrediction_vip', makePredData(predVip, 'vip'));
        await fbSet('meta/latestPrediction_normal', makePredData(predNormal, 'normal'));

        lg(`Predictions saved: HIGH=#${predHigh.predictedNum} VIP=#${predVip.predictedNum} NORMAL=#${predNormal.predictedNum}`);
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
// AI CHAT
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

  const groqKey = await getGroqKey();
  if (!groqKey) return jsonResp({ error: 'AI service not configured' }, 503);

  const recentResults = await queryCollection('results', 'period', 'DESCENDING', 20);
  const resultContext = recentResults.map(r =>
    `Period ${r.periodStr || r.period}: №${r.number} | ${r.colour} | ${r.bigSmall}`
  ).join('\n');

  const tier = keyResult.data.tier || 'basic';
  const metaKey = tier === 'vip' ? 'meta/latestPrediction_vip'
    : tier === 'premium' ? 'meta/latestPrediction'
    : 'meta/latestPrediction_normal';
  const latestPredDoc = await fbGet(metaKey);
  const lp = latestPredDoc?.fields ? parseDoc(latestPredDoc.fields) : null;
  const predContext = lp
    ? `Latest Prediction for period ${lp.period}: №${lp.number ?? lp.predictedNum} | ${lp.colour ?? lp.predictedColor} | ${lp.bigSmall ?? lp.predictedBS} (Num:${lp.numberConfidence ?? lp.numConf}% Color:${lp.colorConf}% B/S:${lp.bsConf}%) [Mode: ${lp.mode}]`
    : 'No prediction available';

  const systemPrompt = `You are ANASHRAW WINGO AI, an expert WinGo 1-minute game pattern analyst.

LIVE DATA (last 20 results, newest first):
${resultContext}

${predContext}

GAME RULES:
- Numbers: 0-9
- 0,5 = Violet | 1,3,7,9 = Green | 2,4,6,8 = Red  
- 0-4 = SMALL | 5-9 = BIG

ANTI-BET LOGIC ACTIVE:
- Numbers/colors with high public betting volume are AVOIDED in predictions
- Streak reversals are factored in

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
        'Authorization': `Bearer ${groqKey}`,
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
    return jsonResp({ ok: true, reply, remaining: quota.remaining, max: quota.max, used: quota.used });
  } catch (e) {
    return jsonResp({ error: 'AI request failed: ' + e.message }, 502);
  }
}

// ═══════════════════════════════════════════════════════════════
// VALIDATE KEY HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleValidateKey(request) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const { key } = body;
  if (!key) return jsonResp({ ok: false, error: 'Key required' }, 400);

  const keyResult = await validateKey(key);
  if (!keyResult.ok) return jsonResp({ ok: false, error: keyResult.msg });

  const settings = await getGlobalSettings();
  const today = new Date().toISOString().split('T')[0];
  const quotaId = `${key.toUpperCase()}_${today}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const quotaDoc = await fbGet(`quota/${quotaId}`);
  const used = quotaDoc?.fields?.used?.integerValue ? parseInt(quotaDoc.fields.used.integerValue) : 0;
  const maxQ = (keyResult.data.questionsOverride != null)
    ? parseInt(keyResult.data.questionsOverride)
    : parseInt(settings.questionsPerDay || 5);

  return jsonResp({
    ok: true,
    data: {
      key: keyResult.data.key,
      label: keyResult.data.label || '',
      tier: keyResult.data.tier || 'basic',
      status: keyResult.data.status,
      lifetime: keyResult.data.lifetime || false,
      expiresAt: keyResult.data.expiresAt || null,
      confidenceMode: keyResult.data.confidenceMode || 'normal',
      questionsOverride: keyResult.data.questionsOverride || null
    },
    remaining: Math.max(0, maxQ - used),
    max: maxQ,
    used
  });
}

// ═══════════════════════════════════════════════════════════════
// PREDICTION ENDPOINT (tier-based mode)
// ═══════════════════════════════════════════════════════════════
async function handlePrediction(request, url) {
  const key = url.searchParams.get('key');
  let tier = 'basic';
  if (key) {
    const kv = await validateKey(key);
    if (!kv.ok) return jsonResp({ error: kv.msg }, 401);
    tier = kv.data.tier || 'basic';
  }

  // Pick prediction based on tier
  const metaKey = tier === 'vip' ? 'meta/latestPrediction_vip'
    : (tier === 'premium' || tier === 'basic') ? 'meta/latestPrediction'
    : 'meta/latestPrediction_normal';

  const doc = await fbGet(metaKey);
  if (!doc?.fields) return jsonResp({ error: 'No prediction yet' }, 404);
  return jsonResp({ prediction: parseDoc(doc.fields) });
}

// ═══════════════════════════════════════════════════════════════
// HEARTBEAT
// ═══════════════════════════════════════════════════════════════
async function handleHeartbeat(request) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const { key } = body;
  if (!key) return jsonResp({ error: 'key required' }, 400);
  await fbSet(`sessions/${key.toUpperCase()}`, {
    key: key.toUpperCase(),
    lastSeen: new Date().toISOString(),
    kicked: false
  });
  return jsonResp({ ok: true });
}

// ═══════════════════════════════════════════════════════════════
// SAVE CHAT
// ═══════════════════════════════════════════════════════════════
async function handleSaveChat(request) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const { key, role, content, chatId, senderName, isGuest } = body;
  if (!key || !role || !content) return jsonResp({ error: 'key, role, content required' }, 400);
  const id = chatId || key;
  const newMsg = {
    role,
    content,
    timestamp: new Date().toISOString(),
    senderName: senderName || null,
    isGuest: isGuest || false
  };
  const ok = await fbArrayUnion(`adminChat/${id}`, 'messages', newMsg);
  return jsonResp({ ok });
}

// ═══════════════════════════════════════════════════════════════
// UPDATE API KEY
// ═══════════════════════════════════════════════════════════════
async function handleUpdateApiKey(request) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const { apiKey, service } = body;
  if (!apiKey) return jsonResp({ error: 'apiKey required' }, 400);
  const ok = await fbSet('settings/apiKeys', {
    groqKey: apiKey,
    service: service || 'groq',
    updatedAt: new Date().toISOString()
  });
  return jsonResp({ ok });
}

// ═══════════════════════════════════════════════════════════════
// MAIN ROUTER
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

    if (path === '/validate-key' && request.method === 'POST') return handleValidateKey(request);
    if (path === '/heartbeat' && request.method === 'POST') return handleHeartbeat(request);
    if (path === '/save-chat' && request.method === 'POST') return handleSaveChat(request);
    if (path === '/ai-chat' && request.method === 'POST') return handleAIChat(request);
    if (path === '/prediction' && request.method === 'GET') return handlePrediction(request, url);

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
      return jsonResp({ used, max: maxQ, remaining: Math.max(0, maxQ - used), tier: kv.data.tier || 'basic', confidenceMode: kv.data.confidenceMode || 'normal', label: kv.data.label || '', lifetime: kv.data.lifetime || false, expiresAt: kv.data.expiresAt || null });
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

    if (path === '/admin/trim' && request.method === 'POST') {
      const settings = await getGlobalSettings();
      const result = await trimResults(settings.maxResults);
      return jsonResp({ ok: true, ...result, message: `Trimmed ${result.trimmed} results` });
    }

    if (path === '/admin/update-api-key' && request.method === 'POST') return handleUpdateApiKey(request);

    if (path === '/health') {
      const collMeta = await fbGet('meta/collector');
      const latestMeta = await fbGet('meta/latest');
      const settings = await getGlobalSettings();
      return jsonResp({
        status: 'ok',
        version: 'v12-NEWDB',
        firebase_project: FIREBASE_PROJECT,
        collector: collMeta?.fields ? parseDoc(collMeta.fields) : null,
        latest: latestMeta?.fields ? parseDoc(latestMeta.fields) : null,
        settings
      });
    }

    return jsonResp({
      name: 'ANASHRAW WINGO AI Worker v12',
      firebase: FIREBASE_PROJECT,
      routes: [
        '/validate-key [POST]', '/heartbeat [POST]', '/save-chat [POST]',
        '/ai-chat [POST]', '/prediction [GET]', '/results [GET]',
        '/quota [GET]', '/settings [GET]', '/collect [GET]',
        '/admin/trim [POST]', '/admin/update-api-key [POST]', '/health [GET]'
      ],
      author: 'ANASHRAW DIXIT'
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCollector());
  }
};
