/* -------------------------------------------------------
   OOR NAME GENERATOR (SEPARATE — DOES NOT TOUCH PROXY)
--------------------------------------------------------*/

// Upstash Redis (raw credentials)
const UPSTASH_REDIS_REST_URL = "https://true-liger-27415.upstash.io";
const UPSTASH_REDIS_REST_TOKEN = "AmsXAAIgcDIpnskeS5gL2HzKyaaKPgvWwbG24CjfQYNJrB6WiehLPg";

async function redis(cmd, ...args) {
  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`
    },
    body: JSON.stringify([cmd, ...args])
  });
  const data = await res.json();
  return data.result;
}

const DATAMUSE = "https://api.datamuse.com/words";
const PREFIX = "oor";

const RAW_SEEDS = [
  "oor@forever","oor@aurora","oor@legacy","oor@popcorn","oor@elite","oor@bliss",
  "oor@essence","oor@timeless","oor@flix","oor@verse","oor@storm","oor@unstoppable",
  "oor@eternal","oor@beyond","oor@awakened","oor@evenmore","oor@true","oor@drift",
  "oor@pulse","oor@vibe","oor@echo","oor@dawn","oor@orbit","oor@hype","oor@realm",
  "oor@space","oor@nova"
];

function normalizeSeed(s) {
  s = s.toLowerCase().trim();
  if (s.startsWith("oor@")) s = s.slice(4);
  if (s.startsWith("oor.")) s = s.slice(4);
  return s;
}

const SEEDS = RAW_SEEDS.map(normalizeSeed);

function validWord(w) {
  if (!/^[a-z]{4,12}$/.test(w)) return false;
  if (w.endsWith("ing") || w.endsWith("s")) return false;
  return true;
}

async function datamuseQuery(params) {
  const url = new URL(DATAMUSE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
  return res.json();
}

async function buildPool() {
  const cached = await redis("GET", "oor_pool_cache");
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  const set = new Set();

  for (const seed of SEEDS) {
    const items = await datamuseQuery({ ml: seed, max: 250 });
    for (const item of items) {
      const w = item.word?.toLowerCase();
      if (validWord(w)) set.add(w);
    }
  }

  const pool = Array.from(set);
  await redis("SET", "oor_pool_cache", JSON.stringify(pool));
  return pool;
}

async function generateName() {
  const used = new Set(await redis("SMEMBERS", "oor_used_words") || []);
  const pool = await buildPool();

  const available = pool.filter(w => !used.has(w));
  if (available.length === 0) throw new Error("No words left.");

  const pick = available[Math.floor(Math.random() * available.length)];
  await redis("SADD", "oor_used_words", pick);
  return PREFIX + pick;
}

async function handleGenerateName(request) {
  try {
    const id = await generateName();
    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

/* -------------------------------------------------------
     YOUR ORIGINAL PROXY — UNTOUCHED
--------------------------------------------------------*/

async function handleProxy(request) {

  const url = new URL(request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const guerrillaParams = new URLSearchParams(url.search);

  guerrillaParams.set("ip", "127.0.0.1");
  guerrillaParams.set("agent", "OOR_Mail_Client");

  const sid = guerrillaParams.get("sid");

  const apiUrl = `https://api.guerrillamail.com/ajax.php?${guerrillaParams.toString()}`;

  const requestHeaders = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json"
  };

  if (sid) {
    requestHeaders["Cookie"] = `PHPSESSID=${sid}`;
  }

  try {
    const response = await fetch(apiUrl, { method: "GET", headers: requestHeaders });

    const rawCookies = response.headers.get("set-cookie");
    let newSid = null;
    if (rawCookies) {
      const match = rawCookies.match(/PHPSESSID=([^;]+)/);
      if (match?.[1]) newSid = match[1];
    }

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Upstream API Error: ${text}`);
    }

    data.sid_token = newSid || sid;

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

/* -------------------------------------------------------
     MAIN ROUTER — clean, simple, safe
--------------------------------------------------------*/

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // NEW endpoint
    if (
      url.pathname.endsWith("/ajax.php") &&
      url.searchParams.get("f") === "generate_oor_name"
    ) {
      return handleGenerateName(request);
    }

    // Everything else → your original proxy
    return handleProxy(request);
  }
};
