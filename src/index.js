export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS HEADERS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. BUILD UPSTREAM URL (Universal Forwarding)
    // We take ALL parameters sent to this worker and pass them to Guerrilla
    const guerrillaParams = new URLSearchParams(url.search);
    
    // Force required overrides
    guerrillaParams.set("ip", "127.0.0.1");
    guerrillaParams.set("agent", "OOR_Mail_Client");

    // Extract SID for Cookie header, but keep it in params too just in case
    const sid = guerrillaParams.get("sid");

    const apiUrl = `https://api.guerrillamail.com/ajax.php?${guerrillaParams.toString()}`;

    // 3. HEADERS
    const requestHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Accept": "application/json"
    };

    if (sid) {
      requestHeaders["Cookie"] = `PHPSESSID=${sid}`;
    }

    try {
      const response = await fetch(apiUrl, { method: "GET", headers: requestHeaders });
      
      // 4. HANDLE NEW SESSION COOKIES
      const rawCookies = response.headers.get("set-cookie");
      let newSid = null;
      if (rawCookies) {
        const match = rawCookies.match(/PHPSESSID=([^;]+)/);
        if (match && match[1]) newSid = match[1];
      }

      // 5. PARSE & RETURN
      // If Guerrilla returns empty string (rare error), catch it
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch(e) {
         // If JSON parse fails, return the raw text for debugging
         throw new Error(`Upstream API Error: ${text}`);
      }

      if (newSid) data.sid_token = newSid;
      else data.sid_token = sid;

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
};
