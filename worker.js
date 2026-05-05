// Cloudflare Worker — WinGo Firebase Collector
// Runs every 5 minutes via Cron Trigger

const FIREBASE_PROJECT = 'anashrawwingokey';
const FIREBASE_API_KEY = 'AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
const MAX_RESULTS = 500;

const WINGO_URLS = [
  'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=',
];

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

// Fetch WinGo API
async function fetchWinGo() {
  for (const baseUrl of WINGO_URLS) {
    const url = baseUrl + Date.now();
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, */*',
          'Referer': 'https://draw.ar-lottery01.com/',
          'Origin': 'https://draw.ar-lottery01.com',
        }
      });

      if (!resp.ok) {
        console.log(`HTTP ${resp.status} from ${url}`);
        continue;
      }

      const text = await resp.text();
      if (text.trim().startsWith('<')) {
        console.log('Got HTML instead of JSON');
        continue;
      }

      const json = JSON.parse(text);

      // Extract list
      let list = [];
      if (json.data && Array.isArray(json.data.list)) list = json.data.list;
      else if (json.data && Array.isArray(json.data)) list = json.data;
      else if (Array.isArray(json)) list = json;
      else if (json.list) list = json.list;

      if (!list.length) continue;

      // Normalize
      const norm = list.map(item => {
        const num = parseInt(item.openNum ?? item.number ?? item.num ?? '99');
        const period = String(item.issue ?? item.issueNumber ?? item.period ?? item.id ?? '?');
        let col = String(item.colour ?? item.color ?? '').toLowerCase();
        if (!col && !isNaN(num)) col = colorOf(num);
        let bs = String(item.bigSmall ?? item.BigSmall ?? '').toUpperCase();
        if (!bs && !isNaN(num)) bs = sizeOf(num);
        return { period, number: num, colour: col, bigSmall: bs };
      }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);

      if (norm.length) return norm;

    } catch (e) {
      console.log('Fetch error:', e.message);
    }
  }
  return null;
}

// Firebase REST API helpers
async function fbGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return await resp.json();
}

async function fbSet(path, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;

  // Convert data to Firestore format
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (v === null) fields[k] = { nullValue: null };
  }

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return resp.ok;
}

async function fbExists(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url);
  return resp.ok;
}

// Main collector logic
async function runCollector() {
  console.log('WinGo Collector — Starting...');
  console.log(new Date().toISOString());

  // Fetch data
  const norm = await fetchWinGo();
  if (!norm) {
    console.log('FAILED: Could not fetch WinGo data');
    return { success: false, message: 'Fetch failed' };
  }

  const latestPeriod = norm[0].period;
  console.log(`Fetched ${norm.length} results. Latest: ${latestPeriod}`);
  console.log(`Sample: №${norm[0].number} | ${norm[0].colour} | ${norm[0].bigSmall}`);

  // Check if already stored
  const metaDoc = await fbGet('meta/latest');
  const storedPeriod = metaDoc?.fields?.period?.stringValue || '';

  if (latestPeriod === storedPeriod) {
    console.log('Same period — no update needed');
    return { success: true, message: 'No new data' };
  }

  console.log(`New period: ${storedPeriod} → ${latestPeriod}`);

  // Save new results
  let added = 0;
  for (const r of norm) {
    const exists = await fbExists(`results/${r.period}`);
    if (!exists) {
      await fbSet(`results/${r.period}`, {
        period: r.period,
        number: r.number,
        colour: r.colour,
        bigSmall: r.bigSmall,
        savedAt: new Date().toISOString()
      });
      added++;
    }
  }

  console.log(`Saved ${added} new results`);

  // Update meta/latest
  await fbSet('meta/latest', {
    period: latestPeriod,
    number: norm[0].number,
    colour: norm[0].colour,
    bigSmall: norm[0].bigSmall,
    updatedAt: new Date().toISOString()
  });

  return {
    success: true,
    message: `Saved ${added} new results. Latest: ${latestPeriod}`
  };
}

// Worker handler
export default {
  // HTTP trigger (for testing)
  async fetch(request, env, ctx) {
    const result = await runCollector();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  // Cron trigger (runs every 5 min)
  async scheduled(event, env, ctx) {
    await runCollector();
  }
};

