// --- CONFIGURATION ---
// CHANGED: Point directly to the upstream API to avoid Error 1042 (Loop)
const BASE_URL = "https://api.guerrillamail.com/ajax.php"; 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Main function to handle the OTP request
export async function handleOtpRequest(request) {
  const url = new URL(request.url);
  const mailParam = url.searchParams.get("mail");
  const platformParam = url.searchParams.get("platform");

  // 1. Validate Inputs
  if (!mailParam || !mailParam.includes("@")) {
    return jsonResponse({ error: "Invalid email. Usage: /otp?mail=user@email.com&platform=netflix" }, 400);
  }
  if (!platformParam) {
    return jsonResponse({ error: "Missing platform. Usage: /otp?mail=...&platform=netflix" }, 400);
  }

  const userPart = mailParam.split("@")[0].toLowerCase();
  const platform = platformParam.toLowerCase();

  try {
    // 2. Start Session (Get Token)
    // We call get_email_address to initialize a session ID (sid_token)
    const sessionData = await callOorApi({ f: "get_email_address" });
    const sidToken = sessionData.sid_token;
    
    if (!sidToken) throw new Error("Failed to initialize session (No sid_token returned).");

    // 3. Set the Manual Email User
    // We must pass the sid_token so the server knows which session to update
    await callOorApi({ 
      f: "set_email_user", 
      email_user: userPart, 
      sid_token: sidToken 
    });

    // 4. Get Inbox List
    const inboxData = await callOorApi({ 
      f: "get_email_list", 
      sid_token: sidToken, 
      offset: 0 
    });

    const msgList = inboxData.list || [];

    // If inbox is empty
    if (msgList.length === 0) {
      return jsonResponse({ 
        status: "empty", 
        message: "No emails found.",
        email: mailParam,
        results: []
      });
    }

    // 5. Slice the top 5 emails (New to Old)
    const topEmails = msgList.slice(0, 5);

    // 6. Process all 5 emails concurrently
    const results = await Promise.all(topEmails.map(async (msg) => {
      const mailId = msg.mail_id;
      const subject = msg.mail_subject || "";
      const timestamp = msg.mail_timestamp;

      // Fetch Body
      const bodyData = await callOorApi({ 
        f: "fetch_email", 
        sid_token: sidToken, 
        email_id: mailId 
      });
      
      const rawBody = bodyData.mail_body || "";
      const otpCode = extractOtp(rawBody, subject, platform);

      return {
        mail_id: mailId,
        code: otpCode, 
        subject: unescapeHtml(subject),
        date_time: convertToIST(timestamp)
      };
    }));

    // 7. Return JSON Response
    const anyCodeFound = results.some(r => r.code !== null);

    return jsonResponse({
      status: anyCodeFound ? "success" : "no_code_found_in_top_5",
      platform: platform,
      email: mailParam,
      count: results.length,
      messages: results
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// --- HELPER FUNCTIONS ---

async function callOorApi(params) {
  const url = new URL(BASE_URL);
  
  // Add standard params
  params.ip = "127.0.0.1";
  params.agent = "OOR_Mail_Client";
  
  // Append params to URL
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  // Prepare Headers
  const headers = { "User-Agent": USER_AGENT };
  
  // CRITICAL FIX: Send the SID as a Cookie header too, otherwise set_email_user might not stick
  if (params.sid_token) {
    headers["Cookie"] = `PHPSESSID=${params.sid_token}`;
  }

  const response = await fetch(url, { 
    method: "GET",
    headers: headers 
  });

  if (!response.ok) {
    throw new Error(`Upstream API Error: ${response.status}`);
  }

  return await response.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 
      "Content-Type": "application/json", 
      "Access-Control-Allow-Origin": "*" 
    },
    status: status
  });
}

function convertToIST(unixTimestamp) {
  if (!unixTimestamp) return "Unavailable";
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleString("en-IN", { 
    timeZone: "Asia/Kolkata", 
    hour12: true,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function unescapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ");
}

// --- CORE EXTRACTION LOGIC ---
function extractOtp(htmlContent, subject, platform) {
  const cleanHtml = unescapeHtml(htmlContent || "");
  const cleanSubject = unescapeHtml(subject || "");
  const textOnly = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  if (platform === 'zee5') {
    const subMatch = cleanSubject.match(/^(\d{4})\s+is your ZEE5/);
    if (subMatch) return subMatch[1];
    const bodyMatch = textOnly.match(/Password\(OTP\)\s+(\d{4})/i);
    if (bodyMatch) return bodyMatch[1];
  } 
  else if (platform === 'netflix') {
    const htmlMatch = cleanHtml.match(/class="[^"]*lrg-number[^"]*".*?>\s*(\d{4,6})\s*</);
    if (htmlMatch) return htmlMatch[1];
    const textMatch = textOnly.match(/Enter this code.*?(\d{4})/);
    if (textMatch) return textMatch[1];
  }

  return null;
}
