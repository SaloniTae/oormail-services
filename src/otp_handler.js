// --- CONFIGURATION ---
const BASE_URL = "https://api.guerrillamail.com/ajax.php";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function handleOtpRequest(request) {
  const url = new URL(request.url);
  const mailParam = url.searchParams.get("mail");
  const platformParam = url.searchParams.get("platform");

  if (!mailParam || !mailParam.includes("@")) return jsonResponse({ error: "Invalid email." }, 400);
  if (!platformParam) return jsonResponse({ error: "Missing platform." }, 400);

  const userPart = mailParam.split("@")[0].toLowerCase();
  const platform = platformParam.toLowerCase();

  try {
    // 1. Init Session
    const sessionData = await callOorApi({ f: "get_email_address" });
    const sidToken = sessionData.sid_token;
    if (!sidToken) throw new Error("No session token.");

    // 2. Set User
    await callOorApi({ f: "set_email_user", email_user: userPart, sid_token: sidToken });

    // 3. Get Inbox List
    const inboxData = await callOorApi({ f: "get_email_list", sid_token: sidToken, offset: 0 });
    const msgList = inboxData.list || [];

    if (msgList.length === 0) return jsonResponse({ status: "empty", message: "Inbox empty" });

    // --- STRICT SUBJECT FILTERING ---
    // We filter the list immediately. If the subject is not EXACT, we drop the email.

    const candidates = msgList.filter(msg => {
      const sub = (msg.mail_subject || "").trim();
      
      // ZEE5 STRICT RULE: "<OTP> is your ZEE5 verification OTP"
      if (platform === 'zee5') {
        // Regex: Starts with 4 digits, followed strictly by the text
        return /^(\d{4})\s+is\s+your\s+ZEE5\s+verification\s+OTP$/i.test(sub);
      }

      // NETFLIX STRICT RULE: "Netflix: your sign-in code"
      if (platform === 'netflix') {
        // Regex: Matches exact phrase (case insensitive)
        return /^Netflix:\s+your\s+sign-in\s+code$/i.test(sub);
      }

      return false;
    });

    // If no emails matched the strict criteria
    if (candidates.length === 0) {
      return jsonResponse({
        status: "not_found",
        message: `No emails found with the strictly required subject line for ${platform}.`,
        email: mailParam
      });
    }

    // 4. PROCESS THE CANDIDATES (Top 3 only)
    const topCandidates = candidates.slice(0, 3);

    const promises = topCandidates.map(async (msg) => {
      const subject = msg.mail_subject || "";
      
      // --- ZEE5 LOGIC ---
      if (platform === 'zee5') {
        // Since we enforced the subject structure in the filter, 
        // we KNOW the code is the first 4 digits.
        // We do NOT need to fetch the body.
        const match = subject.match(/^(\d{4})/);
        if (match) {
          return {
            found: true,
            code: match[1],
            subject: unescapeHtml(subject),
            date_time: convertToIST(msg.mail_timestamp),
            timestamp: msg.mail_timestamp
          };
        }
      }

      // --- NETFLIX LOGIC ---
      if (platform === 'netflix') {
        // The subject is generic ("Netflix: your sign-in code").
        // We MUST fetch the body to get the actual numbers.
        const bodyData = await callOorApi({ 
          f: "fetch_email", 
          sid_token: sidToken, 
          email_id: msg.mail_id 
        });

        const rawBody = bodyData.mail_body || "";
        const code = extractNetflixBody(rawBody);

        if (code) {
          return {
            found: true,
            code: code,
            subject: unescapeHtml(subject),
            date_time: convertToIST(msg.mail_timestamp),
            timestamp: msg.mail_timestamp
          };
        }
      }
      return { found: false };
    });

    const results = await Promise.all(promises);
    
    // Get latest valid result
    const validResults = results
      .filter(r => r.found)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (validResults.length > 0) {
      const latest = validResults[0];
      return jsonResponse({
        status: "success",
        platform: platform,
        email: mailParam,
        code: latest.code,
        date_time: latest.date_time,
        subject: latest.subject
      });
    } else {
      return jsonResponse({
        status: "not_found",
        message: `Found email with correct subject, but body extraction failed.`,
        email: mailParam
      });
    }

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// --- HELPERS ---

async function callOorApi(params) {
  const url = new URL(BASE_URL);
  params.ip = "127.0.0.1"; params.agent = "OOR_Mail_Client";
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
  
  const headers = { "User-Agent": USER_AGENT };
  if (params.sid_token) headers["Cookie"] = `PHPSESSID=${params.sid_token}`;

  const response = await fetch(url, { headers });
  return await response.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    status: status
  });
}

function convertToIST(unixTimestamp) {
  if (!unixTimestamp) return "Unavailable";
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function unescapeHtml(str) {
  if (!str) return "";
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ");
}

// --- EXTRACTION LOGIC ---

function extractNetflixBody(htmlContent) {
  const cleanHtml = unescapeHtml(htmlContent || "");
  const textOnly = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // 1. HTML Class Check (Standard Netflix Template)
  // Checks for <div class="...lrg-number...">1234</div>
  const htmlMatch = cleanHtml.match(/class="[^"]*lrg-number[^"]*".*?>\s*(\d{4,6})\s*</);
  if (htmlMatch) return htmlMatch[1];

  // 2. Text Context Check (Fallback)
  // Checks for "Enter this code ... 1234"
  const textMatch = textOnly.match(/Enter this code.*?(\d{4})/);
  if (textMatch) return textMatch[1];

  return null;
}
