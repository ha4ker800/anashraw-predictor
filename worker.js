// Cloudflare Worker — WinGo Firebase Collector v5
// Reads maxResults from Firebase settings/collector
const FIREBASE_PROJECT='anashrawwingokey';
const FIREBASE_API_KEY='AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
const DEFAULT_MAX=500;
const WINGO_URL='https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100&language=0&ts=';

function colorOf(n){if(n===0||n===5)return'violet';if([1,3,7,9].includes(n))return'green';return'red';}
function sizeOf(n){return n>=5?'BIG':'SMALL';}

async function fetchWinGo(){
  try{
    const resp=await fetch(WINGO_URL+Date.now(),{headers:{'User-Agent':'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36','Accept':'application/json, */*','Referer':'https://draw.ar-lottery01.com/','Origin':'https://draw.ar-lottery01.com'}});
    if(!resp.ok)return null;
    const text=await resp.text();
    if(text.trim().startsWith('<'))return null;
    const json=JSON.parse(text);
    let list=[];
    if(json.data&&Array.isArray(json.data.list))list=json.data.list;
    else if(json.data&&Array.isArray(json.data))list=json.data;
    else if(Array.isArray(json))list=json;
    else if(json.list)list=json.list;
    if(!list.length)return null;
    return list.map(item=>{
      const num=parseInt(item.openNum??item.number??item.num??'99');
      const period=String(item.issue??item.issueNumber??item.period??item.id??'?');
      let col=String(item.colour??item.color??'').toLowerCase();if(!col&&!isNaN(num))col=colorOf(num);
      let bs=String(item.bigSmall??item.BigSmall??'').toUpperCase();if(!bs&&!isNaN(num))bs=sizeOf(num);
      return{period,number:num,colour:col,bigSmall:bs};
    }).filter(x=>!isNaN(x.number)&&x.number>=0&&x.number<=9);
  }catch(e){return null;}
}

const FB=`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

async function fbGet(path){
  try{const r=await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`);if(!r.ok)return null;return await r.json();}
  catch(e){return null;}
}
async function fbSet(path,data){
  const fields={};
  for(const[k,v]of Object.entries(data)){
    if(typeof v==='string')fields[k]={stringValue:v};
    else if(typeof v==='number')fields[k]={integerValue:String(Math.floor(v))};
    else if(typeof v==='boolean')fields[k]={booleanValue:v};
  }
  try{const r=await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields})});return r.ok;}
  catch(e){return false;}
}
async function fbExists(path){
  try{const r=await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`);return r.ok;}
  catch(e){return false;}
}
async function fbDelete(path){
  try{const r=await fetch(`${FB}/${path}?key=${FIREBASE_API_KEY}`,{method:'DELETE'});return r.ok;}
  catch(e){return false;}
}

// Get maxResults from Firebase settings/collector
async function getMaxResults(){
  try{
    const doc=await fbGet('settings/collector');
    if(doc&&doc.fields&&doc.fields.maxResults){
      const v=parseInt(doc.fields.maxResults.integerValue||doc.fields.maxResults.doubleValue||DEFAULT_MAX);
      return isNaN(v)?DEFAULT_MAX:v;
    }
  }catch(e){}
  return DEFAULT_MAX;
}

// Get all doc IDs sorted by period ASC (oldest first)
async function getAllDocsSorted(){
  const url=`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  const body={structuredQuery:{from:[{collectionId:'results'}],select:{fields:[{fieldPath:'__name__'},{fieldPath:'period'}]},orderBy:[{field:{fieldPath:'period'},direction:'ASCENDING'}],limit:2000}};
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)return[];
    const json=await r.json();
    return json.filter(x=>x.document).map(x=>({name:x.document.name,period:x.document.fields?.period?.stringValue||''}));
  }catch(e){return[];}
}

async function trimIfNeeded(maxResults){
  const docs=await getAllDocsSorted();
  const count=docs.length;
  if(count<=maxResults)return{trimmed:0,total:count};
  const toDelete=count-maxResults;
  const oldest=docs.slice(0,toDelete);
  let deleted=0;
  for(const doc of oldest){
    const docId=doc.name.split('/').pop();
    const ok=await fbDelete(`results/${docId}`);
    if(ok)deleted++;
  }
  return{trimmed:deleted,total:count-deleted};
}

async function runCollector(){
  console.log('=== WinGo Collector v5 ===');
  console.log(new Date().toISOString());

  // 1. Get max results limit from Firebase (admin-controlled)
  const MAX_RESULTS=await getMaxResults();
  console.log(`Max results limit: ${MAX_RESULTS}`);

  // 2. Fetch WinGo data
  const norm=await fetchWinGo();
  if(!norm||!norm.length)return{success:false,message:'Fetch failed'};

  const latestPeriod=norm[0].period;
  console.log(`Fetched ${norm.length}. Latest: ${latestPeriod}`);

  // 3. Check meta
  const metaDoc=await fbGet('meta/latest');
  const storedPeriod=metaDoc?.fields?.period?.stringValue||'';

  if(latestPeriod===storedPeriod){
    // No new data but still trim if needed
    const trimResult=await trimIfNeeded(MAX_RESULTS);
    return{success:true,message:`No new data. Trimmed:${trimResult.trimmed}. Total:${trimResult.total}. Max:${MAX_RESULTS}`};
  }

  console.log(`New: ${storedPeriod} → ${latestPeriod}`);

  // 4. Save new results
  let added=0;
  for(const r of norm){
    const exists=await fbExists(`results/${r.period}`);
    if(!exists){
      const ok=await fbSet(`results/${r.period}`,{period:r.period,number:r.number,colour:r.colour,bigSmall:r.bigSmall,savedAt:new Date().toISOString()});
      if(ok)added++;
    }
  }
  console.log(`Added ${added}`);

  // 5. Update meta
  await fbSet('meta/latest',{period:latestPeriod,number:norm[0].number,colour:norm[0].colour,bigSmall:norm[0].bigSmall,updatedAt:new Date().toISOString()});

  // 6. Trim old
  const trimResult=await trimIfNeeded(MAX_RESULTS);

  return{success:true,message:`Added:${added}. Trimmed:${trimResult.trimmed}. Total:${trimResult.total}. Max:${MAX_RESULTS}. Latest:${latestPeriod}`};
}

export default{
  async fetch(request,env,ctx){
    const result=await runCollector();
    return new Response(JSON.stringify(result,null,2),{headers:{'Content-Type':'application/json'}});
  },
  async scheduled(event,env,ctx){
    await runCollector();
  }
};
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
