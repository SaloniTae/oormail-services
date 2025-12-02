// --- CONFIGURATION ---
const BASE_URL = "https://api.guerrillamail.com/ajax.php";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Main function to handle the OTP request
export async function handleOtpRequest(request) {
  const url = new URL(request.url);
  const mailParam = url.searchParams.get("mail");
  const platformParam = url.searchParams.get("platform");

  // 1. Validate Inputs
  if (!mailParam || !mailParam.includes("@")) {
    return jsonResponse({ error: "Invalid email parameter." }, 400);
  }
  if (!platformParam) {
    return jsonResponse({ error: "Missing platform parameter." }, 400);
  }

  const userPart = mailParam.split("@")[0].toLowerCase();
  const platform = platformParam.toLowerCase();

  try {
    // 2. Initialize Session (Get Token)
    const sessionData = await callOorApi({ f: "get_email_address" });
    const sidToken = sessionData.sid_token;

    if (!sidToken) throw new Error("Failed to init session.");

    // 3. Set Email User (Link username to session)
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

    if (msgList.length === 0) {
      return jsonResponse({ status: "empty", message: "Inbox is empty" });
    }

    // 5. CONCURRENT PROCESSING (The "Fast" Part)
    // We take the top 10 emails. We fetch all their bodies AT THE SAME TIME.
    // This is much faster than a loop.
    const scanLimit = 10; 
    const emailsToScan = msgList.slice(0, scanLimit);

    const promises = emailsToScan.map(async (msg) => {
      const subject = msg.mail_subject || "";
      
      // OPTIMIZATION: For Zee5, check Subject FIRST. 
      // If code is in subject, we don't even need to fetch the body (Super fast).
      if (platform === 'zee5') {
        const subjectCode = extractZee5Subject(subject);
        if (subjectCode) {
          return {
            found: true,
            code: subjectCode,
            subject: unescapeHtml(subject),
            date_time: convertToIST(msg.mail_timestamp),
            timestamp: msg.mail_timestamp // used for sorting
          };
        }
      }

      // Fetch Body (if not found in subject or different platform)
      const bodyData = await callOorApi({ 
        f: "fetch_email", 
        sid_token: sidToken, 
        email_id: msg.mail_id 
      });

      const rawBody = bodyData.mail_body || "";
      const code = extractOtp(rawBody, subject, platform);

      if (code) {
        return {
          found: true,
          code: code,
          subject: unescapeHtml(subject),
          date_time: convertToIST(msg.mail_timestamp),
          timestamp: msg.mail_timestamp
        };
      }
      
      return { found: false }; // No code in this email
    });

    // Wait for all checks to finish
    const results = await Promise.all(promises);

    // 6. Filter & Sort to get the LATEST valid code
    const validResults = results
      .filter(r => r.found)
      .sort((a, b) => b.timestamp - a.timestamp); // Sort Newest -> Oldest

    if (validResults.length > 0) {
      // Return the specific latest match
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
        message: `No ${platform} OTP found in recent emails.`,
        email: mailParam
      });
    }

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// --- HELPER FUNCTIONS ---

async function callOorApi(params) {
  const url = new URL(BASE_URL);
  params.ip = "127.0.0.1";
  params.agent = "OOR_Mail_Client";
  
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  const headers = { "User-Agent": USER_AGENT };
  // Important: Pass session ID as cookie for upstream
  if (params.sid_token) {
    headers["Cookie"] = `PHPSESSID=${params.sid_token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
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
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function unescapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ");
}

// --- EXACT PYTHON REGEX PORT ---

function extractZee5Subject(subject) {
  const cleanSubject = unescapeHtml(subject || "");
  // Python: r'^(\d{4})\s+is your ZEE5'
  const match = cleanSubject.match(/^(\d{4})\s+is your ZEE5/);
  return match ? match[1] : null;
}

function extractOtp(htmlContent, subject, platform) {
  const cleanHtml = unescapeHtml(htmlContent || "");
  const cleanSubject = unescapeHtml(subject || "");
  const textOnly = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  if (platform === 'zee5') {
    // 1. Subject Check (Already done in optimization, but double check here safe)
    const subMatch = cleanSubject.match(/^(\d{4})\s+is your ZEE5/);
    if (subMatch) return subMatch[1];

    // 2. Body Check
    // Python: r'Password\(OTP\)\s+(\d{4})'
    const bodyMatch = textOnly.match(/Password\(OTP\)\s+(\d{4})/i);
    if (bodyMatch) return bodyMatch[1];
  } 
  else if (platform === 'netflix') {
    // 1. HTML Class Check
    // Python: r'class="[^"]*lrg-number[^"]*".*?>\s*(\d{4,6})\s*<'
    // JS Regex dot (.) doesn't match newlines by default, use [\s\S]
    const htmlMatch = cleanHtml.match(/class="[^"]*lrg-number[^"]*".*?>\s*(\d{4,6})\s*</);
    if (htmlMatch) return htmlMatch[1];

    // 2. Text Context Check
    // Python: r'Enter this code.*?(\d{4})'
    const textMatch = textOnly.match(/Enter this code.*?(\d{4})/);
    if (textMatch) return textMatch[1];
  }

  return null;
}
