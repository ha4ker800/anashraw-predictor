// collector.js — Firebase Data Collector
// Deploy on GitHub Actions — runs every 1 minute 24/7

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const https = require('https');

// Init Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const API_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?ts=' + Date.now();
const MAX_RESULTS = 500;

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🔄 Fetching WinGo API...');
  try {
    const json = await fetchJSON(API_URL);

    // Smart extractor
    let list = [];
    if (json.data && Array.isArray(json.data.list)) list = json.data.list;
    else if (json.data && Array.isArray(json.data)) list = json.data;
    else if (Array.isArray(json)) list = json;
    else if (json.list && Array.isArray(json.list)) list = json.list;
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

    if (!list.length) { console.log('❌ No data found in API response'); return; }

    // Normalize
    const norm = list.map(item => {
      const num = parseInt(item.openNum ?? item.number ?? item.num ?? item.drawNum ?? '99');
      const period = String(item.issue ?? item.issueNumber ?? item.period ?? item.id ?? '?');
      let col = String(item.colour ?? item.color ?? item.winColor ?? '').toLowerCase();
      if (!col && !isNaN(num)) col = colorOf(num);
      let bs = String(item.bigSmall ?? item.size ?? item.BigSmall ?? '').toUpperCase();
      if (!bs && !isNaN(num)) bs = sizeOf(num);
      return { period, number: num, colour: col, bigSmall: bs };
    }).filter(x => !isNaN(x.number) && x.number >= 0 && x.number <= 9);

    if (!norm.length) { console.log('❌ No valid results after normalize'); return; }

    const latestPeriod = norm[0]?.period;
    console.log(`✅ Got ${norm.length} results. Latest period: ${latestPeriod}`);

    // Check if this period already exists
    const metaRef = db.collection('meta').doc('latest');
    const metaSnap = await metaRef.get();
    const storedLatest = metaSnap.exists ? metaSnap.data().period : '';

    if (latestPeriod === storedLatest) {
      console.log('⏭️ Same period, no update needed');
      return;
    }

    // Get current stored count
    const countSnap = await db.collection('meta').doc('stats').get();
    const currentCount = countSnap.exists ? (countSnap.data().count || 0) : 0;

    // Add new results to Firestore (batch write)
    const batch = db.batch();
    let added = 0;

    for (const r of norm) {
      // Check if period already stored
      const existing = await db.collection('results').doc(r.period).get();
      if (!existing.exists) {
        batch.set(db.collection('results').doc(r.period), {
          ...r,
          savedAt: FieldValue.serverTimestamp()
        });
        added++;
      }
    }

    await batch.commit();
    console.log(`💾 Added ${added} new results to Firebase`);

    // Update meta
    await metaRef.set({ period: latestPeriod, updatedAt: FieldValue.serverTimestamp() });

    // Trim to MAX_RESULTS — delete oldest if over limit
    const totalAfter = currentCount + added;
    if (totalAfter > MAX_RESULTS) {
      const toDelete = totalAfter - MAX_RESULTS;
      const oldSnap = await db.collection('results')
        .orderBy('savedAt', 'asc')
        .limit(toDelete)
        .get();
      const delBatch = db.batch();
      oldSnap.docs.forEach(d => delBatch.delete(d.ref));
      await delBatch.commit();
      console.log(`🗑️ Deleted ${toDelete} oldest results (keeping ${MAX_RESULTS})`);
    }

    // Update stats
    const newCount = Math.min(totalAfter, MAX_RESULTS);
    await db.collection('meta').doc('stats').set({ count: newCount, updatedAt: FieldValue.serverTimestamp() });

    console.log(`✅ Done! Firebase now has ${newCount} results`);

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

main();
