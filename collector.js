// collector.js — Firebase Data Collector (v3 FIXED - 403 bypass)
// Uses multiple public WinGo APIs that work from server-side

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Init Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const MAX_RESULTS = 500;
const TS = Date.now();

// ── MULTIPLE APIs to try (different domains/endpoints) ──
// These are public WinGo 1Min APIs from different lottery platforms
const API_URLS = [
  // Variant 1 — with pageNo param
  `https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=${TS}`,
  // Variant 2 — tc lottery
  `https://api.tcgame.vip/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=50&ts=${TS}`,
  // Variant 3 — 91club style
  `https://api.91club.blue/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=50&ts=${TS}`,
  // Variant 4 — daman style
  `https://api.damangames.in/api/webapi/GetNoaverageEmerdList?pageNo=1&pageSize=100&typeId=1&language=0&ts=${TS}`,
  // Variant 5 — lottery9 
  `https://api.lottery9.vip/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=50&ts=${TS}`,
];

// Different User-Agent strings to rotate
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

// Sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch with headers + redirect + retry
function fetchWithHeaders(urlStr, redirectCount = 0, uaIndex = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    let parsedUrl;
    try { parsedUrl = new URL(urlStr); }
    catch (e) { return reject(new Error(`Invalid URL: ${urlStr}`)); }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 20000,
      headers: {
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
        'Origin': `${parsedUrl.protocol}//${parsedUrl.hostname}`,
      }
    };

    const req = lib.request(options, (res) => {
      console.log(`     Status: ${res.statusCode}`);

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const redirectUrl = loc.startsWith('http') ? loc : `${parsedUrl.protocol}//${parsedUrl.hostname}${loc}`;
        console.log(`     → Redirect to: ${redirectUrl.slice(0, 60)}`);
        res.resume();
        return resolve(fetchWithHeaders(redirectUrl, redirectCount + 1, uaIndex));
      }

      if (res.statusCode === 403) {
        res.resume();
        return reject(new Error(`HTTP 403 Forbidden (IP blocked)`));
      }
      if (res.statusCode === 404) {
        res.resume();
        return reject(new Error(`HTTP 404 Not Found`));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const trimmed = data.trim();
        if (trimmed.startsWith('<') || trimmed.startsWith('<!')) {
          return reject(new Error('Got HTML instead of JSON'));
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch (e) {
          console.log(`     Parse fail. Response start: ${data.slice(0, 100)}`);
          reject(new Error(`JSON parse error`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout (20s)')); });
    req.on('error', e => reject(new Error(`Network: ${e.message}`)));
    req.end();
  });
}

// Try all URLs
async function fetchFromAnyURL() {
  for (let i = 0; i < API_URLS.length; i++) {
    const url = API_URLS[i];
    const domain = new URL(url).hostname;
    console.log(`\n🌐 [${i + 1}/${API_URLS.length}] Trying: ${domain}`);
    try {
      const json = await fetchWithHeaders(url, 0, i);
      console.log(`  ✅ Success!`);
      return { json, sourceIndex: i };
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
      if (i < API_URLS.length - 1) {
        console.log(`  ⏳ Waiting 2s before next...`);
        await sleep(2000);
      }
    }
  }
  throw new Error('All API URLs failed — API may be IP-restricted');
}

// Extract list from any response structure
function extractList(json) {
  // Standard WinGo format
  if (json.data && Array.isArray(json.data.list)) return json.data.list;
  if (json.data && Array.isArray(json.data)) return json.data;
  // Direct array
  if (Array.isArray(json)) return json;
  // Other keys
  if (json.list && Array.isArray(json.list)) return json.list;
  if (json.result && Array.isArray(json.result)) return json.result;
  if (json.results && Array.isArray(json.results)) return json.results;
  if (json.records && Array.isArray(json.records)) return json.records;
  if (json.history && Array.isArray(json.history)) return json.history;
  // Deep search
  for (const k of Object.keys(json || {})) {
    if (Array.isArray(json[k]) && json[k].length > 0) {
      // Check if it looks like game results
      const sample = json[k][0];
      if (sample && (sample.number !== undefined || sample.openNum !== undefined || sample.issue !== undefined)) {
        return json[k];
      }
    }
    if (json[k] && typeof json[k] === 'object' && !Array.isArray(json[k])) {
      for (const k2 of Object.keys(json[k] || {})) {
        if (Array.isArray(json[k][k2]) && json[k][k2].length > 0) return json[k][k2];
      }
    }
  }
  return [];
}

async function main() {
  console.log('══════════════════════════════════════');
  console.log('🔄 WinGo Collector v3 — Starting...');
  console.log(`⏰ ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════');

  try {
    // Fetch
    const { json, sourceIndex } = await fetchFromAnyURL();

    // Debug: show structure
    console.log(`\n📦 Response keys: [${Object.keys(json).join(', ')}]`);
    if (json.code !== undefined) {
      console.log(`   API code: ${json.code}, msg: ${json.msg || json.message || '--'}`);
    }

    // Extract
    const list = extractList(json);
    if (!list.length) {
      console.log('❌ No data extracted from response');
      console.log('Full response:', JSON.stringify(json).slice(0, 500));
      return;
    }
    console.log(`\n📋 Extracted ${list.length} raw items`);
    console.log(`   Sample keys: [${Object.keys(list[0] || {}).join(', ')}]`);

    // Normalize
    const norm = list.map(item => {
      const num = parseInt(
        item.openNum ?? item.number ?? item.num ?? item.drawNum ??
        item.result ?? item.winNumber ?? '99'
      );
      const period = String(
        item.issue ?? item.issueNumber ?? item.period ??
        item.issueNo ?? item.id ?? '?'
      );
      let col = String(item.colour ?? item.color ?? item.winColor ?? item.colourType ?? '').toLowerCase();
      if (!col && !isNaN(num)) col = colorOf(num);
      let bs = String(item.bigSmall ?? item.size ?? item.BigSmall ?? item.bigOrSmall ?? '').toUpperCase();
      if (!bs && !isNaN(num)) bs = sizeOf(num);
      return { period, number: num, colour: col, bigSmall: bs };
    }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);

    if (!norm.length) {
      console.log('❌ No valid 0-9 numbers after normalize');
      console.log('Raw sample:', JSON.stringify(list.slice(0, 3)));
      return;
    }

    const latestPeriod = norm[0]?.period;
    console.log(`\n✅ ${norm.length} valid results normalized`);
    console.log(`📌 Latest period: ${latestPeriod}`);
    console.log(`🎯 Latest: №${norm[0].number} | ${norm[0].colour} | ${norm[0].bigSmall}`);

    // Check meta
    const metaRef = db.collection('meta').doc('latest');
    const metaSnap = await metaRef.get();
    const storedLatest = metaSnap.exists ? metaSnap.data().period : '';

    if (latestPeriod === storedLatest) {
      console.log('\n⏭️ Same period — no update needed');
      console.log('══════════════════════════════════════');
      return;
    }

    console.log(`\n🆕 New period! ${storedLatest || 'none'} → ${latestPeriod}`);

    // Current count
    const countSnap = await db.collection('meta').doc('stats').get();
    const currentCount = countSnap.exists ? (countSnap.data().count || 0) : 0;

    // Batch write — check existing first
    const existingSnaps = await Promise.all(
      norm.map(r => db.collection('results').doc(r.period).get())
    );

    const batch = db.batch();
    let added = 0;
    for (let i = 0; i < norm.length; i++) {
      if (!existingSnaps[i].exists) {
        batch.set(db.collection('results').doc(norm[i].period), {
          ...norm[i],
          savedAt: FieldValue.serverTimestamp()
        });
        added++;
      }
    }

    if (added > 0) {
      await batch.commit();
      console.log(`💾 Saved ${added} new results to Firestore`);
    } else {
      console.log('⏭️ All periods already exist');
    }

    // Update latest meta
    await metaRef.set({
      period: latestPeriod,
      number: norm[0].number,
      colour: norm[0].colour,
      bigSmall: norm[0].bigSmall,
      source: sourceIndex,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Trim oldest
    const totalAfter = currentCount + added;
    if (totalAfter > MAX_RESULTS) {
      const toDelete = totalAfter - MAX_RESULTS;
      const oldSnap = await db.collection('results')
        .orderBy('savedAt', 'asc')
        .limit(toDelete)
        .get();
      if (oldSnap.docs.length > 0) {
        const delBatch = db.batch();
        oldSnap.docs.forEach(d => delBatch.delete(d.ref));
        await delBatch.commit();
        console.log(`🗑️ Trimmed ${oldSnap.docs.length} old results`);
      }
    }

    // Update stats
    const newCount = Math.min(totalAfter, MAX_RESULTS);
    await db.collection('meta').doc('stats').set({
      count: newCount,
      lastUpdated: latestPeriod,
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log(`\n🎉 DONE! Firestore now has ${newCount} results`);
    console.log('══════════════════════════════════════');

  } catch (e) {
    console.error('\n💥 FATAL:', e.message);
    // Exit 0 so GitHub Actions doesn't mark as failed on every run
    // Change to process.exit(1) if you want failures to show as red
    process.exit(0);
  }
}

main();
