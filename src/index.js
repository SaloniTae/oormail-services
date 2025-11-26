export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS HEADERS (Crucial for your HTML to talk to this Worker)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle Browser Pre-checks
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. GET PARAMETERS
    const func = url.searchParams.get("f");
    const sid = url.searchParams.get("sid");
    const email_id = url.searchParams.get("email_id"); 
    const offset = url.searchParams.get("offset") || "0";
    const seq = url.searchParams.get("seq");

    // 3. BUILD GUERRILLA URL
    // We act as a proxy because browsers can't talk to Guerrilla directly due to CORS
    let apiUrl = `https://api.guerrillamail.com/ajax.php?f=${func}&ip=127.0.0.1&agent=OOR_Mail_Client`;

    if (email_id) apiUrl += `&email_id=${email_id}`;
    if (offset) apiUrl += `&offset=${offset}`;
    if (seq) apiUrl += `&seq=${seq}`;

    // 4. PREPARE HEADERS
    const requestHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Accept": "application/json"
    };

    if (sid) {
      requestHeaders["Cookie"] = `PHPSESSID=${sid}`;
    }

    try {
      // 5. FETCH FROM GUERRILLA
      const response = await fetch(apiUrl, { 
        method: "GET", 
        headers: requestHeaders 
      });
      
      // 6. HANDLE COOKIES (Session Management)
      const rawCookies = response.headers.get("set-cookie");
      let newSid = null;
      if (rawCookies) {
        const match = rawCookies.match(/PHPSESSID=([^;]+)/);
        if (match && match[1]) newSid = match[1];
      }

      const data = await response.json();

      // Pass session ID back to frontend
      if (newSid) data.sid_token = newSid;
      else data.sid_token = sid;

      // 7. RETURN RESPONSE (With CORS headers)
      return new Response(JSON.stringify(data), {
        headers: { 
          "Content-Type": "application/json",
          ...corsHeaders 
        }
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { 
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
