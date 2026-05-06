// Cloudflare Worker — WinGo Firebase Collector v4 FIXED TRIM
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

// ── FETCH WINGO ──────────────────────────────────────
async function fetchWinGo() {
  try {
    const resp = await fetch(WINGO_URL + Date.now(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36',
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
  } catch (e) { return null; }
}

// ── FIREBASE HELPERS ─────────────────────────────────
const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

async function fbGet(path) {
  try {
    const resp = await fetch(`${FB_BASE}/${path}?key=${FIREBASE_API_KEY}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) { return null; }
}

async function fbSet(path, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(Math.floor(v)) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
  }
  try {
    const resp = await fetch(`${FB_BASE}/${path}?key=${FIREBASE_API_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return resp.ok;
  } catch(e) { return false; }
}

async function fbExists(path) {
  try {
    const resp = await fetch(`${FB_BASE}/${path}?key=${FIREBASE_API_KEY}`);
    return resp.ok;
  } catch(e) { return false; }
}

async function fbDelete(path) {
  try {
    const resp = await fetch(`${FB_BASE}/${path}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
    return resp.ok;
  } catch(e) { return false; }
}

// ── GET TOTAL COUNT using runQuery ───────────────────
async function fbCount() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'results' }],
      select: { fields: [{ fieldPath: '__name__' }] },
      orderBy: [{ field: { fieldPath: 'period' }, direction: 'ASCENDING' }],
      limit: 1000
    }
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) return { count: 0, docs: [] };
    const json = await resp.json();
    // Filter valid docs
    const docs = json.filter(r => r.document).map(r => ({
      name: r.document.name,
      period: r.document.fields?.period?.stringValue || r.document.name.split('/').pop()
    }));
    return { count: docs.length, docs };
  } catch(e) { return { count: 0, docs: [] }; }
}

// ── TRIM: delete oldest results if over MAX ──────────
async function trimIfNeeded() {
  const { count, docs } = await fbCount();
  console.log(`Current count: ${count}`);

  if (count <= MAX_RESULTS) {
    return { trimmed: 0, total: count };
  }

  const toDelete = count - MAX_RESULTS;
  // docs are sorted by period ASC — oldest first
  const oldest = docs.slice(0, toDelete);

  let deleted = 0;
  for (const doc of oldest) {
    const docId = doc.name.split('/').pop();
    const ok = await fbDelete(`results/${docId}`);
    if (ok) deleted++;
  }

  console.log(`Trimmed ${deleted} old results`);
  return { trimmed: deleted, total: count - deleted };
}

// ── MAIN ─────────────────────────────────────────────
async function runCollector() {
  console.log('=== WinGo Collector v4 ===');
  console.log(new Date().toISOString());

  // 1. Fetch
  const norm = await fetchWinGo();
  if (!norm || !norm.length) {
    return { success: false, message: 'Fetch failed' };
  }

  const latestPeriod = norm[0].period;
  console.log(`Fetched ${norm.length}. Latest: ${latestPeriod}`);

  // 2. Check meta
  const metaDoc = await fbGet('meta/latest');
  const storedPeriod = metaDoc?.fields?.period?.stringValue || '';

  if (latestPeriod === storedPeriod) {
    // Still trim if needed even if no new data
    const trimResult = await trimIfNeeded();
    return { success: true, message: `No new data. Trimmed: ${trimResult.trimmed}. Total: ${trimResult.total}` };
  }

  console.log(`New: ${storedPeriod} → ${latestPeriod}`);

  // 3. Save new results
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
  console.log(`Added ${added} new results`);

  // 4. Update meta
  await fbSet('meta/latest', {
    period: latestPeriod,
    number: norm[0].number,
    colour: norm[0].colour,
    bigSmall: norm[0].bigSmall,
    updatedAt: new Date().toISOString()
  });

  // 5. Trim old
  const trimResult = await trimIfNeeded();

  return {
    success: true,
    message: `Added ${added}. Trimmed ${trimResult.trimmed}. Total: ${trimResult.total}. Latest: ${latestPeriod}`
  };
}

// ── WORKER EXPORT ────────────────────────────────────
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
