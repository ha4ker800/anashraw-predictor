// Cloudflare Worker — WinGo Firebase Collector (FIXED)
// Runs every 5 minutes via Cron Trigger

const FIREBASE_PROJECT = 'anashrawwingokey';
const FIREBASE_API_KEY = 'AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
const MAX_RESULTS = 500;

const WINGO_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=';

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

// Fetch WinGo API
async function fetchWinGo() {
  const url = WINGO_URL + Date.now();
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, */*',
        'Referer': 'https://draw.ar-lottery01.com/',
        'Origin': 'https://draw.ar-lottery01.com',
      }
    });

    if (!resp.ok) return null;

    const text = await resp.text();
    if (text.trim().startsWith('<')) return null;

    const json = JSON.parse(text);

    let list = [];
    if (json.data && Array.isArray(json.data.list)) list = json.data.list;
    else if (json.data && Array.isArray(json.data)) list = json.data;
    else if (Array.isArray(json)) list = json;
    else if (json.list) list = json.list;

    if (!list.length) return null;

    return list.map(item => {
      const num = parseInt(item.openNum ?? item.number ?? item.num ?? '99');
      const period = String(item.issue ?? item.issueNumber ?? item.period ?? item.id ?? '?');
      let col = String(item.colour ?? item.color ?? '').toLowerCase();
      if (!col && !isNaN(num)) col = colorOf(num);
      let bs = String(item.bigSmall ?? item.BigSmall ?? '').toUpperCase();
      if (!bs && !isNaN(num)) bs = sizeOf(num);
      return { period, number: num, colour: col, bigSmall: bs };
    }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);

  } catch (e) {
    return null;
  }
}

// ── FIREBASE REST HELPERS ──────────────────────────────

// GET document
async function fbGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) { return null; }
}

// SET/UPDATE document (PATCH)
async function fbSet(path, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(Math.floor(v)) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (v === null) fields[k] = { nullValue: null };
  }
  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return resp.ok;
  } catch(e) { return false; }
}

// CHECK if document exists
async function fbExists(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  try {
    const resp = await fetch(url);
    return resp.ok;
  } catch(e) { return false; }
}

// DELETE document
async function fbDelete(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  try {
    const resp = await fetch(url, { method: 'DELETE' });
    return resp.ok;
  } catch(e) { return false; }
}

// GET all documents in collection (with ordering)
async function fbList(collection, orderBy = 'savedAt', limit = 600) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}?key=${FIREBASE_API_KEY}&pageSize=${limit}&orderBy=${orderBy}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    return json.documents || [];
  } catch(e) { return []; }
}

// ── TRIM OLD RESULTS ────────────────────────────────────
async function trimOldResults() {
  // Get all results ordered by savedAt (oldest first)
  const allDocs = await fbList('results', 'savedAt', 600);

  if (allDocs.length <= MAX_RESULTS) {
    return { trimmed: 0, total: allDocs.length };
  }

  const toDelete = allDocs.length - MAX_RESULTS;
  const oldestDocs = allDocs.slice(0, toDelete); // oldest ones

  let deleted = 0;
  for (const doc of oldestDocs) {
    // Extract document ID from name field
    const docId = doc.name.split('/').pop();
    const ok = await fbDelete(`results/${docId}`);
    if (ok) deleted++;
  }

  return { trimmed: deleted, total: allDocs.length - deleted };
}

// ── MAIN COLLECTOR ──────────────────────────────────────
async function runCollector() {
  console.log('=== WinGo Collector FIXED — Starting ===');
  console.log(new Date().toISOString());

  // 1. Fetch data
  const norm = await fetchWinGo();
  if (!norm || !norm.length) {
    return { success: false, message: 'Fetch failed — API may be blocked' };
  }

  const latestPeriod = norm[0].period;
  console.log(`Fetched ${norm.length} results. Latest: ${latestPeriod}`);

  // 2. Check if already stored
  const metaDoc = await fbGet('meta/latest');
  const storedPeriod = metaDoc?.fields?.period?.stringValue || '';

  if (latestPeriod === storedPeriod) {
    console.log('Same period — no update needed');
    return { success: true, message: `No new data. Latest: ${latestPeriod}` };
  }

  console.log(`New period: ${storedPeriod} → ${latestPeriod}`);

  // 3. Save new results (only ones not already stored)
  let added = 0;
  for (const r of norm) {
    const exists = await fbExists(`results/${r.period}`);
    if (!exists) {
      const saved = await fbSet(`results/${r.period}`, {
        period: r.period,
        number: r.number,
        colour: r.colour,
        bigSmall: r.bigSmall,
        savedAt: new Date().toISOString()
      });
      if (saved) added++;
    }
  }

  console.log(`Saved ${added} new results`);

  // 4. Update meta/latest
  await fbSet('meta/latest', {
    period: latestPeriod,
    number: norm[0].number,
    colour: norm[0].colour,
    bigSmall: norm[0].bigSmall,
    updatedAt: new Date().toISOString()
  });

  // 5. TRIM old results if over MAX_RESULTS
  const trimResult = await trimOldResults();
  console.log(`Trim: deleted ${trimResult.trimmed}, total now: ${trimResult.total}`);

  return {
    success: true,
    message: `Saved ${added} new. Trimmed ${trimResult.trimmed}. Total: ${trimResult.total}. Latest: ${latestPeriod}`
  };
}

// ── WORKER HANDLER ──────────────────────────────────────
export default {
  // HTTP trigger (for manual testing)
  async fetch(request, env, ctx) {
    const result = await runCollector();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  // Cron trigger (runs every 5 min automatically)
  async scheduled(event, env, ctx) {
    await runCollector();
  }
};
