// --- CONFIGURATION ---
const BASE_URL = "https://oormail-services.by-oor.workers.dev/ajax.php";
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
    const sessionData = await callOorApi({ f: "get_email_address" });
    const sidToken = sessionData.sid_token;
    if (!sidToken) throw new Error("Failed to initialize session (No sid_token).");

    // 3. Set the Manual Email User
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

    // 6. Process all 5 emails concurrently (using Promise.all for speed)
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
        code: otpCode, // Will be null if not found
        subject: unescapeHtml(subject),
        date_time: convertToIST(timestamp)
      };
    }));

    // 7. Return JSON Response
    // We check if at least one email had a code found to determine overall status
    const anyCodeFound = results.some(r => r.code !== null);

    return jsonResponse({
      status: anyCodeFound ? "success" : "no_code_found_in_top_5",
      platform: platform,
      email: mailParam,
      count: results.length,
      messages: results // Array of 5 objects
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// --- HELPER FUNCTIONS ---

async function callOorApi(params) {
  const url = new URL(BASE_URL);
  params.ip = "127.0.0.1";
  params.agent = USER_AGENT;
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
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
  // IST is UTC+5:30
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
  const cleanHtml = unescapeHtml(htmlContent);
  const cleanSubject = unescapeHtml(subject);
  const textOnly = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  if (platform === 'zee5') {
    const subMatch = cleanSubject.match(/^(\d{4})\s+is your ZEE5/);
    if (subMatch) return subMatch[1];
    const bodyMatch = textOnly.match(/Password\(OTP\)\s+(\d{4})/i);
    if (bodyMatch) return bodyMatch[1];
  } 
  else if (platform === 'netflix') {
    // Matches HTML class or text context
    const htmlMatch = cleanHtml.match(/class="[^"]*lrg-number[^"]*".*?>\s*(\d{4,6})\s*</);
    if (htmlMatch) return htmlMatch[1];
    const textMatch = textOnly.match(/Enter this code.*?(\d{4})/);
    if (textMatch) return textMatch[1];
  }

  return null;
}
