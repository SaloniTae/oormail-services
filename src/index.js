// === OOR Brand Name Generator with Upstash Redis storage ===

// Upstash Redis (raw, no env)
const UPSTASH_REDIS_REST_URL = "https://true-liger-27415.upstash.io";
const UPSTASH_REDIS_REST_TOKEN = "AmsXAAIgcDIpnskeS5gL2HzKyaaKPgvWwbG24CjfQYNJrB6WiehLPg";

// Datamuse
const DATAMUSE_API = "https://api.datamuse.com/words";

const PREFIX = "oor";

const MIN_LEN = 4;
const MAX_LEN = 12;

const SAFE_WORD = /^[a-z]+$/;

const BANNED_SUFFIXES = [
  "ness","tion","sion","ment","ship","ology","logy",
  "able","ible","fully","ingly","ally","edly",
  "ization","isation","izing","ising","ized","ised"
];

const BANNED_PREFIXES = ["un","non","anti","de"];

const BLOCKLIST = new Set(["sex","porn","nsfw","kill","hate","drug","crack","meth"]);

const ALLOW_POS_TAGS = new Set(["n", "adj"]); // nouns/adjectives only

const RAW_SEEDS = [
  "oor@forever","oor@aurora","oor@legacy","oor@popcorn","oor@elite","oor@bliss",
  "oor@essence","oor@timeless","oor@flix","oor@verse","oor@storm","oor@unstoppable",
  "oor@eternal","oor@beyond","oor@awakened","oor@evenmore","oor@true","oor@drift",
  "oor@pulse","oor@vibe","oor@echo","oor@dawn","oor@orbit","oor@hype","oor@realm",
  "oor@space","oor@nova"
];

const TOPICS = [
  "timeless","eternal","legacy","premium","luxury","elite","prestige",
  "cosmic","space","stellar","celestial",
  "power","mighty","valor","royal","regal","legend","new", "beyond"
];

function normalizeSeed(s) {
  s = s.trim().toLowerCase();
  if (s.startsWith("oor@")) s = s.slice(4);
  if (s.startsWith("oor.")) s = s.slice(4);
  return s;
}

const SEEDS = RAW_SEEDS.map(normalizeSeed);
const TOPICS_STRING = TOPICS.join(",");

// ---- small helpers ----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function redisCmd(cmd, ...args) {
  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`
    },
    body: JSON.stringify([cmd, ...args])
  });
  if (!res.ok) throw new Error("Redis HTTP " + res.status);
  const data = await res.json();
  return data.result;
}

// Used words: Redis SET "oor_used_words"
async function loadUsedSet() {
  const arr = await redisCmd("SMEMBERS", "oor_used_words").catch(() => null);
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr);
}

async function addUsedWord(word) {
  try {
    await redisCmd("SADD", "oor_used_words", word);
  } catch (e) {
    // non-critical
  }
}

// Pool cache: Redis GET/SET key "oor_pool_cache" (JSON array of words)
async function loadPoolCache() {
  const raw = await redisCmd("GET", "oor_pool_cache").catch(() => null);
  if (typeof raw !== "string") return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

async function savePoolCache(words) {
  try {
    await redisCmd("SET", "oor_pool_cache", JSON.stringify(words));
  } catch (e) {
    // non-critical
  }
}

// Datamuse helper
async function datamuse(params, retries = 4) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const url = new URL(DATAMUSE_API);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), {
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (!res.ok) throw new Error("Datamuse HTTP " + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(2 ** i * 1000); // 1,2,4,8 sec
    }
  }
  throw new Error("Datamuse failed after retries: " + lastErr);
}

function looksBrandable(word, tags) {
  const w = (word || "").toLowerCase().trim();
  if (!(MIN_LEN <= w.length && w.length <= MAX_LEN)) return false;
  if (!SAFE_WORD.test(w)) return false;
  if (BLOCKLIST.has(w)) return false;
  if (BANNED_PREFIXES.some(p => w.startsWith(p))) return false;
  if (BANNED_SUFFIXES.some(s => w.endsWith(s))) return false;
  if (w.endsWith("s")) return false;
  if (w.endsWith("ing")) return false;

  if (Array.isArray(tags) && tags.length) {
    const hasGoodPos = tags.some(t => {
      const base = String(t).split(":")[0];
      return ALLOW_POS_TAGS.has(base);
    });
    if (!hasGoodPos) return false;
  }

  return true;
}

// Build pool: returns array of words sorted by score desc
async function buildPool(useCache = true) {
  if (useCache) {
    const cached = await loadPoolCache();
    if (cached && cached.length) return cached;
  }

  const pool = new Map(); // word -> best score

  // 1. queries per seed
  for (const seed of SEEDS) {
    const items = await datamuse({
      ml: seed,
      topics: TOPICS_STRING,
      md: "p",
      max: "250"
    });

    for (const item of items) {
      const w = item.word || "";
      const tags = item.tags || [];
      if (!looksBrandable(w, tags)) continue;

      const wl = w.toLowerCase();
      const score = Number(item.score || 0);
      const prev = pool.get(wl) || 0;
      if (score > prev) pool.set(wl, score);
    }
  }

  // 2. combined vibe queries
  const combos = ["timeless cosmic elite", "mighty regal celestial"];
  for (const combo of combos) {
    const items = await datamuse({
      ml: combo,
      topics: TOPICS_STRING,
      md: "p",
      max: "400"
    });
    for (const item of items) {
      const w = item.word || "";
      const tags = item.tags || [];
      if (!looksBrandable(w, tags)) continue;
      const wl = w.toLowerCase();
      const score = Number(item.score || 0);
      const prev = pool.get(wl) || 0;
      if (score > prev) pool.set(wl, score);
    }
  }

  const sortedWords = Array.from(pool.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  await savePoolCache(sortedWords);
  return sortedWords;
}

// Fisher–Yates shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// MAIN GENERATOR: auto rebuild if remaining <= 50
async function generateOorName() {
  const used = await loadUsedSet();

  // First: try from cached pool
  let pool = await buildPool(true);

  let available = pool.filter(w => !used.has(w));

  // If we are down to last <= 50 available → rebuild pool from Datamuse
  if (available.length <= 50) {
    pool = await buildPool(false);    // force rebuild, overwrite cache
    available = pool.filter(w => !used.has(w));
  }

  if (!available.length) {
    throw new Error("No unique words left. Clear Redis or expand seeds/topics.");
  }

  // Strong bias to top 400 words if possible
  const topLimit = Math.min(400, available.length);
  const top = shuffle(available.slice(0, topLimit));

  const chosen = top[0]; // random from best slice
  await addUsedWord(chosen);
  return PREFIX + chosen;
}

// Optional HTTP handler for Worker
async function handleGenerateOorName(request) {
  try {
    const id = await generateOorName();
    return new Response(JSON.stringify({
      ok: true,
      id,
      ts: Math.floor(Date.now() / 1000)
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(e)
    }), {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS"
      }
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
