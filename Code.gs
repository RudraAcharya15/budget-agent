// ============================================================
// BUDGET AGENT — Groq Powered
// BUDGET AGENT — Groq Powered (Fixed Version v2)
// ============================================================

// ============================================================
// CONFIGURATION — stored in PropertiesService
// ============================================================
function getConfig(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value ? value.trim() : null;
}

function validateConfiguration() {
  var required = ['SHEET_ID', 'SHEET_NAME', 'YOUR_EMAIL', 'GROQ_API_KEY'];
  var missing = [];
  for (var i = 0; i < required.length; i++) {
    var val = getConfig(required[i]);
    if (!val || val.indexOf('YOUR_') === 0) {
      missing.push(required[i]);
    }
  }
  if (missing.length > 0) {
    throw new Error('Missing configuration: ' + missing.join(', ') +
      '. Run setup() or set them in Project Settings > Script Properties.');
  }
}

// ============================================================
// CONSTANTS
// ============================================================
var VALID_CATEGORIES = ["Grocery", "Restaurant", "Clothing", "Transport", "Entertainment",
  "Income", "Utilities", "Healthcare", "Insurance", "Rent", "Subscriptions", "Other"];
var VALID_CARDS = ["Amex", "CIBC", "Cash", "Unknown"];
var MAX_AMOUNT = 50000;
var MAX_THREADS_PER_RUN = 20;

var CATEGORY_COLORS = {
  "Grocery": "#4CAF50",
  "Restaurant": "#FF9800",
  "Transport": "#2196F3",
  "Clothing": "#9C27B0",
  "Entertainment": "#F44336",
  "Income": "#00897B",
  "Utilities": "#795548",
  "Healthcare": "#E91E63",
  "Insurance": "#3F51B5",
  "Rent": "#FF5722",
  "Subscriptions": "#009688",
  "Other": "#607D8B"
};

// ============================================================
// SETUP & UI
// ============================================================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Budget Agent')
    .addItem('Process Emails Now', 'processExpenseEmails')
    .addItem('Check Spending Alerts', 'checkSpendingAlerts')
    .addItem('Send Monthly Report', 'sendMonthlyReport')
    .addSeparator()
    .addItem('Setup / Configure', 'setup')
    .addToUi();
}

function setup() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var sheetId = ui.prompt('Setup', 'Enter your Google Sheet ID:', ui.ButtonSet.OK_CANCEL);
  if (sheetId.getSelectedButton() === ui.Button.OK) props.setProperty('SHEET_ID', sheetId.getResponseText().trim());

  var sheetName = ui.prompt('Setup', 'Enter sheet tab name (e.g., "Expenses"):', ui.ButtonSet.OK_CANCEL);
  if (sheetName.getSelectedButton() === ui.Button.OK) props.setProperty('SHEET_NAME', sheetName.getResponseText().trim());

  var email = ui.prompt('Setup', 'Enter your email address:', ui.ButtonSet.OK_CANCEL);
  if (email.getSelectedButton() === ui.Button.OK) props.setProperty('YOUR_EMAIL', email.getResponseText().trim());

  var apiKey = ui.prompt('Setup', 'Enter your Groq API key:', ui.ButtonSet.OK_CANCEL);
  if (apiKey.getSelectedButton() === ui.Button.OK) props.setProperty('GROQ_API_KEY', apiKey.getResponseText().trim());

  ui.alert('Setup complete. You can also set a time-based trigger for processExpenseEmails() and dailyCheck().');
}

// ============================================================
// HTML UTILITIES — escape user-derived strings before embedding
// ============================================================
function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// HTML EMAIL WRAPPER
// ============================================================
function buildEmailWrapper(title, bodyHtml) {
  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">' +
    '<tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">' +
    '<tr><td style="background:#1a1a2e;padding:24px 32px;">' +
    '<h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">' + escapeHtml(title) + '</h1>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 32px;">' + bodyHtml + '</td></tr>' +
    '<tr><td style="background:#f8f8f8;padding:16px 32px;border-top:1px solid #eee;">' +
    '<p style="margin:0;color:#999;font-size:12px;">Budget Tracker &mdash; Automated by Budget Agent</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildViewSheetButton() {
  var sheetId = getConfig('SHEET_ID');
  return '<div style="text-align:center;margin:24px 0 8px;">' +
    '<a href="https://docs.google.com/spreadsheets/d/' + escapeHtml(sheetId) + '/edit" ' +
    'style="display:inline-block;background:#1a1a2e;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:500;">' +
    'View Spreadsheet</a></div>';
}

// ============================================================
// INPUT SANITIZATION — prompt injection defense + HTML strip
// ============================================================
function sanitizeEmailInput(text) {
  if (!text || typeof text !== 'string') return '';
  // Strip HTML tags (forwarded HTML-only emails can leak through getPlainBody)
  var cleaned = text.replace(/<[^>]+>/g, ' ');
  // Remove null bytes and control characters (keep newlines/tabs)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/[ \t]{10,}/g, '  ');
  // Truncate to 1500 chars
  return cleaned.substring(0, 1500);
}

// ============================================================
// DATE VALIDATION — strict date parsing
// ============================================================
function parseStrictDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  var match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  if (year < 2020 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  var d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  // Reject future dates (allow 1 day grace for timezone)
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d > tomorrow) return null;
  return d;
}

// ============================================================
// ENTRY VALIDATION — sanitize LLM output
// ============================================================
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!VALID_CATEGORIES.includes(entry.category)) entry.category = "Other";
  if (!VALID_CARDS.includes(entry.card)) entry.card = "Unknown";

  // Consistent rounding
  var rawAmount = Math.abs(parseFloat(entry.amount));
  entry.amount = Math.round(rawAmount * 100) / 100;
  if (isNaN(entry.amount) || entry.amount <= 0 || entry.amount > MAX_AMOUNT) return null;

  // Strict date validation
  if (!entry.date || !parseStrictDate(entry.date)) return null;

  // Preserve confidence field
  if (entry.confidence !== "high" && entry.confidence !== "low") {
    entry.confidence = "high";
  }

  entry.note = String(entry.note || "").substring(0, 100);
  return entry;
}

// ============================================================
// GROQ: PARSE ALL EXPENSES FROM EMAIL
// ============================================================
function parseWithGroq(emailText) {
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  // Sanitize input before sending to LLM
  var sanitizedText = sanitizeEmailInput(emailText);
  if (!sanitizedText) return { error: "Empty email content after sanitization." };

  var systemPrompt = 'You are a budget tracking assistant. Extract ALL expenses or income entries from the user\'s email and return ONLY a JSON array, no other text, no markdown, no backticks.\n\n' +
    'Today\'s date: ' + today + ' (timezone: ' + tz + ')\n\n' +
    'Categories: ' + VALID_CATEGORIES.join(', ') + '\n\n' +
    'Cards:\n' +
    '- "amex" or "american express" or "ame x" = "Amex"\n' +
    '- "cibc" = "CIBC"\n' +
    '- "cash" or "debit" = "Cash"\n' +
    '- nothing mentioned = "Unknown"\n\n' +
    'Rules:\n' +
    '- Extract EVERY separate expense or income item mentioned\n' +
    '- If no date mentioned, use today\'s date\n' +
    '- All dates must be in yyyy-MM-dd format\n' +
    '- Amount must always be a positive number\n' +
    '- Note should be a clean short description of what/where\n' +
    '- confidence: "high" if category is clear, "low" if uncertain\n\n' +
    'Return exactly this format (array, even if only one item):\n' +
    '[{"date":"yyyy-MM-dd","category":"one of the categories","amount":0.00,"note":"short description","card":"Amex or CIBC or Cash or Unknown","confidence":"high or low"}]';

  var url = "https://api.groq.com/openai/v1/chat/completions";
  var payload = {
    model: "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sanitizedText }
    ],
    temperature: 0.1,
    max_tokens: 1000
  };
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": "Bearer " + getConfig('GROQ_API_KEY') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var waitSeconds = [5, 10, 15];
  var RETRYABLE_CODES = [429, 503, 502, 500];

  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var httpCode = response.getResponseCode();

      // Distinguish retryable from fatal HTTP errors
      if (httpCode >= 400) {
        var errBody = '';
        try { errBody = JSON.parse(response.getContentText()).error.message; } catch(e) { errBody = response.getContentText().substring(0, 200); }

        if (RETRYABLE_CODES.indexOf(httpCode) !== -1 && attempt < 2) {
          Logger.log("Groq returned " + httpCode + ", retrying in " + waitSeconds[attempt] + "s");
          Utilities.sleep(waitSeconds[attempt] * 1000);
          continue;
        }
        // Non-retryable or final attempt
        return { error: "Groq API error (" + httpCode + "): " + errBody };
      }

      var result = JSON.parse(response.getContentText());

      if (result.error) {
        return { error: result.error.message || "Unknown Groq error" };
      }

      var text = result.choices[0].message.content.trim();
      // Strip markdown code fences
      var clean = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();

      var parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (parseErr) {
        return { error: "Invalid JSON from Groq: " + parseErr.toString() + " | Raw: " + clean.substring(0, 100) };
      }

      var entries = Array.isArray(parsed) ? parsed : [parsed];

      // Validate required fields on each entry
      var valid = [];
      for (var v = 0; v < entries.length; v++) {
        var e = entries[v];
        if (e && typeof e === 'object' && e.date && e.amount !== undefined && e.category) {
          valid.push(e);
        } else {
          Logger.log("Dropping malformed entry from Groq: " + JSON.stringify(e));
        }
      }

      if (valid.length === 0) {
        return { error: "Groq returned entries but none had required fields (date, category, amount)." };
      }

      return { entries: valid };

    } catch (e) {
      if (attempt < 2) {
        Utilities.sleep(waitSeconds[attempt] * 1000);
      } else {
        return { error: "Network/parse error: " + e.toString() };
      }
    }
  }

  // Explicit return after loop exhaustion
  return { error: "Groq failed after 3 attempts. Try again later." };
}

// ============================================================
// LOG TO SHEET — with lock-based duplicate detection
// Columns: Date | Category | Amount | Note | Card
// ============================================================
function logToSheet(date, category, amount, note, card, sheet, existingData) {
  var normalizedAmount = Math.round(parseFloat(amount) * 100) / 100;
  var inputDate = parseStrictDate(date);
  if (!inputDate) return false;
  var inputDateStr = Utilities.formatDate(inputDate, Session.getScriptTimeZone(), "yyyy-MM-dd");

  for (var i = 1; i < existingData.length; i++) {
    var rowAmt = Math.round(parseFloat(existingData[i][2]) * 100) / 100;
    var rowDateStr = "";
    try {
      rowDateStr = Utilities.formatDate(new Date(existingData[i][0]), Session.getScriptTimeZone(), "yyyy-MM-dd");
    } catch(e) { continue; }

    if (rowDateStr === inputDateStr && rowAmt === normalizedAmount
        && existingData[i][1] === category && existingData[i][3] === note) {
      Logger.log("Duplicate skipped: " + inputDateStr + " | $" + amount);
      return false;
    }
  }

  sheet.appendRow([inputDateStr, category, normalizedAmount, note, card || "Unknown"]);
  existingData.push([inputDateStr, category, normalizedAmount, note, card || "Unknown"]);
  return true;
}

// ============================================================
// FAILURE EMAIL — with HTML-escaped user content
// ============================================================
function sendFailureEmail(subject, body, errorMsg) {
  var yourEmail = getConfig('YOUR_EMAIL');
  var html = buildEmailWrapper("Budget Agent - Error",
    '<div style="background:#FFF3F3;border-left:4px solid #F44336;padding:16px;border-radius:4px;margin-bottom:16px;">' +
    '<p style="margin:0 0 8px;font-weight:600;color:#D32F2F;">Error</p>' +
    '<p style="margin:0;color:#333;font-family:monospace;font-size:13px;word-break:break-word;">' + escapeHtml(errorMsg) + '</p>' +
    '</div>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#666;font-weight:600;">Original Subject</p>' +
    '<p style="margin:0 0 16px;font-size:14px;color:#333;">' + escapeHtml(subject) + '</p>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#666;font-weight:600;">Original Body (truncated)</p>' +
    '<p style="margin:0;font-size:13px;color:#333;font-family:monospace;background:#f5f5f5;padding:12px;border-radius:4px;word-break:break-word;">' + escapeHtml(body.substring(0, 300)) + '</p>'
  );

  GmailApp.sendEmail(yourEmail,
    "[FAILED] Budget Agent - paste error into Claude",
    "Budget Agent Error: " + errorMsg,
    { htmlBody: html }
  );
}

// ============================================================
// SHARED DATA READER
// ============================================================
function getSheetAndData() {
  var sheetId = getConfig('SHEET_ID');
  var sheetName = getConfig('SHEET_NAME');
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error("Sheet '" + sheetName + "' not found. Check SHEET_NAME in configuration.");
  }
  return { sheet: sheet, data: sheet.getDataRange().getValues() };
}

// ============================================================
// MAIN: PROCESS EXPENSE EMAILS
// ============================================================
function processExpenseEmails() {
  validateConfiguration();

  var labelName = "expense-processed";
  var processedLabel = GmailApp.getUserLabelByName(labelName);
  if (!processedLabel) processedLabel = GmailApp.createLabel(labelName);

  var threads = GmailApp.search("subject:expense -label:expense-processed newer_than:1d", 0, MAX_THREADS_PER_RUN);

  var sheetData = getSheetAndData();
  var sheet = sheetData.sheet;

  // Acquire document lock once for the entire batch
  var lock = LockService.getDocumentLock();

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    var threadSuccess = true;

    for (var m = 0; m < messages.length; m++) {
      var message = messages[m];
      var subject = message.getSubject();
      var body = message.getPlainBody();
      var emailText = "Subject: " + subject + "\n\n" + body;

      var result = parseWithGroq(emailText);

      if (result.error) {
        sendFailureEmail(subject, body, result.error);
        Logger.log("Failed: " + result.error);
        threadSuccess = false;
        continue;
      }

      if (!result.entries || result.entries.length === 0) {
        sendFailureEmail(subject, body, "No entries found in email.");
        threadSuccess = false;
        continue;
      }

      var loggedItems = [];

      // Lock around sheet writes
      lock.waitLock(30000);
      try {
        // Re-read data inside lock to prevent race condition
        var existingData = sheet.getDataRange().getValues();

        for (var e = 0; e < result.entries.length; e++) {
          var clean = sanitizeEntry(result.entries[e]);
          if (!clean) {
            Logger.log("Invalid entry skipped: " + JSON.stringify(result.entries[e]));
            continue;
          }
          var wasLogged = logToSheet(clean.date, clean.category, clean.amount, clean.note, clean.card, sheet, existingData);
          if (wasLogged) {
            loggedItems.push(clean);
            Logger.log("Logged: " + clean.date + " | " + clean.category + " | $" + clean.amount + " | " + clean.note + " | " + clean.card);
          }
        }
      } catch (err) {
        sendFailureEmail(subject, body, "Sheet write failed: " + err.toString());
        threadSuccess = false;
      } finally {
        lock.releaseLock();
      }

      // Send ONE combined HTML confirmation email
      if (loggedItems.length > 0) {
        sendConfirmationEmail(loggedItems);
      } else {
        Logger.log("All entries were duplicates or invalid. No email sent.");
      }
    }

    // Label thread AFTER all messages processed successfully (not before)
    if (threadSuccess) {
      thread.addLabel(processedLabel);
    } else {
      Logger.log("Thread '" + thread.getFirstMessageSubject() + "' had errors — not labeling so it retries next run.");
    }
  }
}

// ============================================================
// CONFIRMATION EMAIL — with HTML-escaped user content
// ============================================================
function sendConfirmationEmail(loggedItems) {
  var yourEmail = getConfig('YOUR_EMAIL');
  var total = 0;
  var tableRows = "";
  for (var i = 0; i < loggedItems.length; i++) {
    var entry = loggedItems[i];
    var color = CATEGORY_COLORS[entry.category] || "#607D8B";
    var bgColor = i % 2 === 0 ? "#ffffff" : "#f9f9f9";
    var confidenceFlag = entry.confidence === "low"
      ? ' <span style="color:#FF9800;font-size:12px;">(uncertain)</span>'
      : '';
    total += entry.amount;

    tableRows += '<tr style="background:' + bgColor + ';">' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee;">' +
      '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-right:8px;vertical-align:middle;"></span>' +
      escapeHtml(entry.category) + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;">$' + entry.amount.toFixed(2) + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;">' + escapeHtml(entry.card) + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;">' + escapeHtml(entry.note) + confidenceFlag + '</td>' +
      '</tr>';
  }

  var totalRounded = Math.round(total * 100) / 100;

  var bodyHtml =
    '<p style="margin:0 0 16px;font-size:15px;color:#333;">' +
    loggedItems.length + ' expense' + (loggedItems.length > 1 ? 's' : '') + ' logged successfully.</p>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">' +
    '<tr style="background:#f0f0f0;">' +
    '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Category</th>' +
    '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Amount</th>' +
    '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Card</th>' +
    '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Note</th>' +
    '</tr>' + tableRows +
    '<tr style="background:#1a1a2e;">' +
    '<td style="padding:12px;color:#fff;font-weight:700;">TOTAL</td>' +
    '<td style="padding:12px;color:#fff;font-weight:700;">$' + totalRounded.toFixed(2) + '</td>' +
    '<td colspan="2" style="padding:12px;"></td>' +
    '</tr></table>' +
    buildViewSheetButton();

  var html = buildEmailWrapper("Expenses Logged", bodyHtml);
  var plainFallback = loggedItems.map(function(e) {
    return e.category + " | $" + e.amount.toFixed(2) + " | " + e.card + " | " + e.note;
  }).join("\n") + "\nTotal: $" + totalRounded.toFixed(2);

  GmailApp.sendEmail(yourEmail,
    loggedItems.length + " expense" + (loggedItems.length > 1 ? "s" : "") + " logged - $" + totalRounded.toFixed(2) + " total",
    plainFallback,
    { htmlBody: html }
  );
}

// ============================================================
// SPENDING ALERT: 20%+ over last month (min $10 threshold)
// ============================================================
function checkSpendingAlerts(providedData) {
  validateConfiguration();

  var data;
  if (providedData) {
    data = providedData;
  } else {
    var sheetData = getSheetAndData();
    data = sheetData.data;
  }

  var now = new Date();
  var thisMonth = now.getMonth();
  var thisYear = now.getFullYear();
  var lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
  var lastMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;

  var thisMonthTotals = {};
  var lastMonthTotals = {};

  for (var i = 1; i < data.length; i++) {
    var category = data[i][1];
    var amount = parseFloat(data[i][2]) || 0;
    if (category === "Income") continue;

    var rowDate;
    try { rowDate = new Date(data[i][0]); } catch(e) { continue; }

    var mo = rowDate.getMonth();
    var yr = rowDate.getFullYear();

    if (mo === thisMonth && yr === thisYear)
      thisMonthTotals[category] = (thisMonthTotals[category] || 0) + amount;
    if (mo === lastMonth && yr === lastMonthYear)
      lastMonthTotals[category] = (lastMonthTotals[category] || 0) + amount;
  }

  var alerts = [];
  var cats = Object.keys(thisMonthTotals);
  for (var j = 0; j < cats.length; j++) {
    var cat = cats[j];
    var thisAmt = thisMonthTotals[cat];
    var lastAmt = lastMonthTotals[cat];
    if (!lastAmt || lastAmt < 10) continue;
    var pct = ((thisAmt - lastAmt) / lastAmt) * 100;
    if (pct >= 20) {
      alerts.push({ category: cat, thisMonth: thisAmt, lastMonth: lastAmt, pct: pct });
    }
  }

  if (alerts.length > 0) {
    var yourEmail = getConfig('YOUR_EMAIL');
    var alertRows = "";
    for (var k = 0; k < alerts.length; k++) {
      var a = alerts[k];
      var clr = CATEGORY_COLORS[a.category] || "#607D8B";
      alertRows += '<tr>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;">' +
        '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + clr + ';margin-right:8px;vertical-align:middle;"></span>' +
        escapeHtml(a.category) + '</td>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;">$' + a.thisMonth.toFixed(2) + '</td>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;">$' + a.lastMonth.toFixed(2) + '</td>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#D32F2F;font-weight:600;">+' + a.pct.toFixed(0) + '%</td>' +
        '</tr>';
    }

    var alertBody =
      '<div style="background:#FFF8E1;border-left:4px solid #FF9800;padding:16px;border-radius:4px;margin-bottom:20px;">' +
      '<p style="margin:0;font-weight:600;color:#E65100;">Spending up 20%+ in ' + alerts.length + ' categor' + (alerts.length > 1 ? 'ies' : 'y') + ' vs last month.</p>' +
      '</div>' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">' +
      '<tr style="background:#f0f0f0;">' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Category</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">This Month</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Last Month</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd;">Change</th>' +
      '</tr>' + alertRows + '</table>' +
      buildViewSheetButton();

    var alertHtml = buildEmailWrapper("Spending Alert", alertBody);
    var alertPlain = alerts.map(function(a) {
      return a.category + ": $" + a.thisMonth.toFixed(2) + " vs $" + a.lastMonth.toFixed(2) + " (+" + a.pct.toFixed(0) + "%)";
    }).join("\n");

    GmailApp.sendEmail(yourEmail,
      "[ALERT] Spending up 20%+ in " + alerts.length + " categor" + (alerts.length > 1 ? "ies" : "y"),
      alertPlain,
      { htmlBody: alertHtml }
    );
  }
}

// ============================================================
// MONTHLY REPORT — HTML with horizontal bar charts
// ============================================================
function sendMonthlyReport(providedData) {
  validateConfiguration();

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var monthName = Utilities.formatDate(now, Session.getScriptTimeZone(), "MMMM yyyy");
  var yourEmail = getConfig('YOUR_EMAIL');

  var data;
  if (providedData) {
    data = providedData;
  } else {
    var sheetData = getSheetAndData();
    data = sheetData.data;
  }

  var categories = {};
  var cardTotals = {};
  var totalIncome = 0;
  var totalExpenses = 0;

  for (var i = 1; i < data.length; i++) {
    var rowDate;
    try { rowDate = new Date(data[i][0]); } catch(e) { continue; }
    if (rowDate.getFullYear() !== year || rowDate.getMonth() !== month) continue;

    var category = data[i][1];
    var amount = parseFloat(data[i][2]) || 0;
    var card = data[i][4] || "Unknown";

    if (category === "Income") {
      totalIncome += amount;
    } else {
      totalExpenses += amount;
      categories[category] = (categories[category] || 0) + amount;
      cardTotals[card] = (cardTotals[card] || 0) + amount;
    }
  }

  var netSavings = Math.round((totalIncome - totalExpenses) * 100) / 100;

  var sortedCategories = Object.entries(categories).sort(function(a, b) { return b[1] - a[1]; });
  var maxAmount = sortedCategories.length > 0 ? sortedCategories[0][1] : 1;

  var barChart = "";
  for (var c = 0; c < sortedCategories.length; c++) {
    var cat = sortedCategories[c][0];
    var amt = sortedCategories[c][1];
    var color = CATEGORY_COLORS[cat] || "#607D8B";
    var pct = Math.max(5, Math.round((amt / maxAmount) * 100));
    var displayPct = ((amt / totalExpenses) * 100).toFixed(1);
    barChart +=
      '<div style="margin-bottom:12px;">' +
      '<div style="margin-bottom:4px;">' +
      '<span style="font-size:14px;font-weight:500;color:#333;">' + escapeHtml(cat) + '</span>' +
      '<span style="float:right;font-size:14px;font-weight:600;color:#333;">$' + amt.toFixed(2) + ' <span style="color:#999;font-weight:400;">(' + displayPct + '%)</span></span>' +
      '</div>' +
      '<div style="background:#f0f0f0;border-radius:6px;height:24px;overflow:hidden;">' +
      '<div style="background:' + color + ';height:100%;width:' + pct + '%;border-radius:6px;min-width:20px;"></div>' +
      '</div></div>';
  }

  var cardRows = "";
  var sortedCards = Object.entries(cardTotals).sort(function(a, b) { return b[1] - a[1]; });
  for (var d = 0; d < sortedCards.length; d++) {
    var cardName = sortedCards[d][0];
    var cardAmt = sortedCards[d][1];
    var cardPct = ((cardAmt / totalExpenses) * 100).toFixed(1);
    cardRows += '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">' + escapeHtml(cardName) + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;font-weight:600;">$' + cardAmt.toFixed(2) + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#999;">' + cardPct + '%</td>' +
      '</tr>';
  }

  var savingsColor = netSavings >= 0 ? "#4CAF50" : "#F44336";
  var savingsLabel = netSavings >= 0 ? "On track" : "Over budget";
  var savingsBg = netSavings >= 0 ? "#E8F5E9" : "#FFEBEE";

  var reportBody =
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr>' +
    '<td width="33%" style="padding:0 4px 0 0;">' +
    '<div style="background:#f9f9f9;border-radius:8px;padding:16px;text-align:center;">' +
    '<p style="margin:0 0 4px;font-size:12px;color:#999;text-transform:uppercase;">Expenses</p>' +
    '<p style="margin:0;font-size:22px;font-weight:700;color:#333;">$' + totalExpenses.toFixed(2) + '</p>' +
    '</div></td>' +
    '<td width="33%" style="padding:0 2px;">' +
    '<div style="background:#f9f9f9;border-radius:8px;padding:16px;text-align:center;">' +
    '<p style="margin:0 0 4px;font-size:12px;color:#999;text-transform:uppercase;">Income</p>' +
    '<p style="margin:0;font-size:22px;font-weight:700;color:#333;">$' + totalIncome.toFixed(2) + '</p>' +
    '</div></td>' +
    '<td width="33%" style="padding:0 0 0 4px;">' +
    '<div style="background:' + savingsBg + ';border-radius:8px;padding:16px;text-align:center;">' +
    '<p style="margin:0 0 4px;font-size:12px;color:#999;text-transform:uppercase;">Net Savings</p>' +
    '<p style="margin:0;font-size:22px;font-weight:700;color:' + savingsColor + ';">$' + netSavings.toFixed(2) + '</p>' +
    '<p style="margin:4px 0 0;font-size:11px;color:' + savingsColor + ';">' + savingsLabel + '</p>' +
    '</div></td></tr></table>' +
    '<h2 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#333;">Expenses by Category</h2>' +
    (barChart || '<p style="color:#999;font-size:14px;">No expenses this month.</p>') +
    '<h2 style="margin:24px 0 12px;font-size:16px;font-weight:600;color:#333;">Spending by Card</h2>' +
    (sortedCards.length > 0 ?
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
      '<tr style="background:#f0f0f0;">' +
      '<th style="padding:8px 12px;text-align:left;font-size:13px;font-weight:600;border-bottom:2px solid #ddd;">Card</th>' +
      '<th style="padding:8px 12px;text-align:left;font-size:13px;font-weight:600;border-bottom:2px solid #ddd;">Amount</th>' +
      '<th style="padding:8px 12px;text-align:left;font-size:13px;font-weight:600;border-bottom:2px solid #ddd;">Share</th>' +
      '</tr>' + cardRows + '</table>'
      : '<p style="color:#999;font-size:14px;">No card data.</p>') +
    buildViewSheetButton();

  var reportHtml = buildEmailWrapper("Budget Report - " + monthName, reportBody);
  var reportPlain = "Budget Report - " + monthName +
    "\nTotal Expenses: $" + totalExpenses.toFixed(2) +
    "\nTotal Income: $" + totalIncome.toFixed(2) +
    "\nNet Savings: $" + netSavings.toFixed(2);

  GmailApp.sendEmail(yourEmail,
    "Budget Report - " + monthName,
    reportPlain,
    { htmlBody: reportHtml }
  );
}

// ============================================================
// DAILY CHECK — monthly report on 1st, alerts on Monday
// ============================================================
function dailyCheck() {
  validateConfiguration();
  var now = new Date();
  var needsReport = (now.getDate() === 1);
  var needsAlerts = (now.getDay() === 1);

  if (needsReport || needsAlerts) {
    // Single sheet read for both functions
    var sheetData = getSheetAndData();
    var data = sheetData.data;

    if (needsReport) sendMonthlyReport(data);
    if (needsAlerts) checkSpendingAlerts(data);
  }
}
