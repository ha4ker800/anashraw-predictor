// collector.js — Firebase Data Collector (FIXED)
// Deploy on GitHub Actions — runs every 1 minute 24/7

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

// Multiple API URLs to try (fallbacks)
const API_URLS = [
  `https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?ts=${TS}`,
  `https://api.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?ts=${TS}`,
  `https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=${TS}`,
];

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

// Proper fetch with headers + redirect follow + timeout
function fetchWithHeaders(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const parsedUrl = new URL(urlStr);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 15000,
      headers: {
        // Pretend to be a real browser so server doesn't block us
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Referer': 'https://draw.ar-lottery01.com/',
        'Origin': 'https://draw.ar-lottery01.com',
      }
    };

    const req = lib.request(options, (res) => {
      console.log(`  → Status: ${res.statusCode} from ${parsedUrl.hostname}`);

      // Follow redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.hostname}${res.headers.location}`;
        console.log(`  → Redirecting to: ${redirectUrl}`);
        res.resume(); // drain response
        return resolve(fetchWithHeaders(redirectUrl, redirectCount + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Check if response is HTML (error page) instead of JSON
        const trimmed = data.trim();
        if (trimmed.startsWith('<') || trimmed.startsWith('<!')) {
          console.log(`  ⚠️ Got HTML response instead of JSON (${data.length} bytes)`);
          console.log(`  First 200 chars: ${data.slice(0, 200)}`);
          return reject(new Error('API returned HTML instead of JSON'));
        }

        try {
          const json = JSON.parse(trimmed);
          resolve(json);
        } catch (e) {
          console.log(`  ⚠️ JSON parse failed. First 200 chars: ${data.slice(0, 200)}`);
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout (15s)'));
    });

    req.on('error', reject);
    req.end();
  });
}

// Try all URLs until one works
async function fetchFromAnyURL() {
  for (let i = 0; i < API_URLS.length; i++) {
    const url = API_URLS[i];
    console.log(`\n🌐 Trying URL ${i + 1}/${API_URLS.length}: ${url.split('?')[0]}`);
    try {
      const json = await fetchWithHeaders(url);
      console.log(`  ✅ Success from URL ${i + 1}`);
      return json;
    } catch (e) {
      console.log(`  ❌ Failed: ${e.message}`);
      if (i < API_URLS.length - 1) console.log('  → Trying next URL...');
    }
  }
  throw new Error('All API URLs failed');
}

// Extract list from any JSON structure
function extractList(json) {
  if (json.data && Array.isArray(json.data.list)) return json.data.list;
  if (json.data && Array.isArray(json.data)) return json.data;
  if (Array.isArray(json)) return json;
  if (json.list && Array.isArray(json.list)) return json.list;
  if (json.result && Array.isArray(json.result)) return json.result;
  if (json.results && Array.isArray(json.results)) return json.results;

  // Deep search
  for (const k of Object.keys(json || {})) {
    if (Array.isArray(json[k]) && json[k].length > 0) return json[k];
    if (json[k] && typeof json[k] === 'object') {
      for (const k2 of Object.keys(json[k] || {})) {
        if (Array.isArray(json[k][k2]) && json[k][k2].length > 0) return json[k][k2];
      }
    }
  }
  return [];
}

async function main() {
  console.log('====================================');
  console.log('🔄 WinGo Collector — Starting...');
  console.log(`⏰ Time: ${new Date().toISOString()}`);
  console.log('====================================');

  try {
    // Fetch data
    const json = await fetchFromAnyURL();

    // Log raw structure for debugging
    console.log(`\n📦 API Response keys: ${Object.keys(json).join(', ')}`);
    if (json.code !== undefined) console.log(`   code: ${json.code}, msg: ${json.msg || json.message || '--'}`);

    // Extract list
    const list = extractList(json);
    if (!list.length) {
      console.log('❌ No data found in API response');
      console.log('Raw response (first 500 chars):', JSON.stringify(json).slice(0, 500));
      return;
    }

    // Normalize results
    const norm = list.map(item => {
      const num = parseInt(item.openNum ?? item.number ?? item.num ?? item.drawNum ?? '99');
      const period = String(item.issue ?? item.issueNumber ?? item.period ?? item.id ?? '?');
      let col = String(item.colour ?? item.color ?? item.winColor ?? '').toLowerCase();
      if (!col && !isNaN(num)) col = colorOf(num);
      let bs = String(item.bigSmall ?? item.size ?? item.BigSmall ?? '').toUpperCase();
      if (!bs && !isNaN(num)) bs = sizeOf(num);
      return { period, number: num, colour: col, bigSmall: bs };
    }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);

    if (!norm.length) {
      console.log('❌ No valid results after normalize');
      console.log('Sample raw item:', JSON.stringify(list[0]));
      return;
    }

    const latestPeriod = norm[0]?.period;
    console.log(`\n✅ Got ${norm.length} valid results`);
    console.log(`📌 Latest period: ${latestPeriod}`);
    console.log(`📊 Sample: №${norm[0].number} | ${norm[0].colour} | ${norm[0].bigSmall}`);

    // Check if already saved
    const metaRef = db.collection('meta').doc('latest');
    const metaSnap = await metaRef.get();
    const storedLatest = metaSnap.exists ? metaSnap.data().period : '';

    if (latestPeriod === storedLatest) {
      console.log('\n⏭️ Same period as stored — no update needed');
      console.log('====================================');
      return;
    }

    console.log(`\n🆕 New period detected: ${storedLatest} → ${latestPeriod}`);

    // Get current count
    const countSnap = await db.collection('meta').doc('stats').get();
    const currentCount = countSnap.exists ? (countSnap.data().count || 0) : 0;
    console.log(`📈 Currently stored: ${currentCount} results`);

    // Batch write new results
    const batch = db.batch();
    let added = 0;

    // Check existing periods in bulk (more efficient)
    const periodsToCheck = norm.map(r => r.period);
    const existingSnaps = await Promise.all(
      periodsToCheck.map(p => db.collection('results').doc(p).get())
    );

    for (let i = 0; i < norm.length; i++) {
      const r = norm[i];
      if (!existingSnaps[i].exists) {
        batch.set(db.collection('results').doc(r.period), {
          ...r,
          savedAt: FieldValue.serverTimestamp()
        });
        added++;
      }
    }

    if (added === 0) {
      console.log('⏭️ All periods already exist in Firebase');
    } else {
      await batch.commit();
      console.log(`💾 Added ${added} new results to Firebase`);
    }

    // Update meta/latest
    await metaRef.set({
      period: latestPeriod,
      number: norm[0].number,
      colour: norm[0].colour,
      bigSmall: norm[0].bigSmall,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Trim oldest if over MAX_RESULTS
    const totalAfter = currentCount + added;
    if (totalAfter > MAX_RESULTS) {
      const toDelete = totalAfter - MAX_RESULTS;
      console.log(`🗑️ Trimming ${toDelete} oldest results...`);
      const oldSnap = await db.collection('results')
        .orderBy('savedAt', 'asc')
        .limit(toDelete)
        .get();
      const delBatch = db.batch();
      oldSnap.docs.forEach(d => delBatch.delete(d.ref));
      await delBatch.commit();
      console.log(`✅ Deleted ${toDelete} old results`);
    }

    // Update stats
    const newCount = Math.min(totalAfter, MAX_RESULTS);
    await db.collection('meta').doc('stats').set({
      count: newCount,
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log(`\n✅ DONE! Firebase now has ${newCount} results`);
    console.log('====================================');

  } catch (e) {
    console.error('\n❌ FATAL ERROR:', e.message);
    console.error('Stack:', e.stack);
    process.exit(1);
  }
}

main();
