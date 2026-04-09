// ============================================================
// BUDGET AGENT — Groq Powered
// ============================================================

const SHEET_ID = "YOUR_SHEET_ID";
const SHEET_NAME = "YOUR_SHEET_NAME";
const YOUR_EMAIL = "YOUR_EMAIL@gmail.com";
const GROQ_API_KEY = "YOUR_GROQ_API_KEY";

// ============================================================
// VALIDATION CONSTANTS
// ============================================================
const VALID_CATEGORIES = ["Grocery", "Restaurant", "Clothing", "Transport", "Entertainment", "Income", "Other"];
const VALID_CARDS = ["Amex", "CIBC", "Cash", "Unknown"];
const MAX_AMOUNT = 50000;

const CATEGORY_COLORS = {
  "Grocery": "#4CAF50",
  "Restaurant": "#FF9800",
  "Transport": "#2196F3",
  "Clothing": "#9C27B0",
  "Entertainment": "#F44336",
  "Income": "#00897B",
  "Other": "#607D8B"
};

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
    '<h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">' + title + '</h1>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 32px;">' + bodyHtml + '</td></tr>' +
    '<tr><td style="background:#f8f8f8;padding:16px 32px;border-top:1px solid #eee;">' +
    '<p style="margin:0;color:#999;font-size:12px;">Budget Tracker &mdash; Automated by Budget Agent</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildViewSheetButton() {
  return '<div style="text-align:center;margin:24px 0 8px;">' +
    '<a href="https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit" ' +
    'style="display:inline-block;background:#1a1a2e;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:500;">' +
    'View Spreadsheet</a></div>';
}

// ============================================================
// ENTRY VALIDATION — sanitize LLM output
// ============================================================
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!VALID_CATEGORIES.includes(entry.category)) entry.category = "Other";
  if (!VALID_CARDS.includes(entry.card)) entry.card = "Unknown";
  entry.amount = Math.abs(parseFloat(entry.amount));
  if (isNaN(entry.amount) || entry.amount <= 0 || entry.amount > MAX_AMOUNT) return null;
  if (!entry.date || isNaN(Date.parse(entry.date))) return null;
  entry.note = String(entry.note || "").substring(0, 100);
  return entry;
}

// ============================================================
// GROQ: PARSE ALL EXPENSES FROM EMAIL
// ============================================================
function parseWithGroq(emailText) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  var systemPrompt = 'You are a budget tracking assistant. Extract ALL expenses or income entries from the user\'s email and return ONLY a JSON array, no other text, no markdown, no backticks.\n\n' +
    'Today\'s date: ' + today + '\n\n' +
    'Categories: Grocery, Restaurant, Clothing, Transport, Entertainment, Income, Other\n\n' +
    'Cards:\n' +
    '- "amex" or "american express" or "ame x" = "Amex"\n' +
    '- "cibc" = "CIBC"\n' +
    '- "cash" or "debit" = "Cash"\n' +
    '- nothing mentioned = "Unknown"\n\n' +
    'Rules:\n' +
    '- Extract EVERY separate expense or income item mentioned\n' +
    '- If no date mentioned, use today\'s date\n' +
    '- Amount must always be a positive number\n' +
    '- Note should be a clean short description of what/where\n' +
    '- confidence: "high" if category is clear, "low" if uncertain\n\n' +
    'Return exactly this format (array, even if only one item):\n' +
    '[{"date":"yyyy-MM-dd","category":"one of the 7 categories","amount":0.00,"note":"short description","card":"Amex or CIBC or Cash or Unknown","confidence":"high or low"}]';

  var url = "https://api.groq.com/openai/v1/chat/completions";
  var payload = {
    model: "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: emailText }
    ],
    temperature: 0.1,
    max_tokens: 1000
  };
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": "Bearer " + GROQ_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var waitSeconds = [5, 10, 15];

  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var result = JSON.parse(response.getContentText());

      if (result.error) {
        var msg = result.error.message || "";
        var isOverloaded = msg.includes("rate limit") || msg.includes("overloaded") || result.error.code === 429;
        if (isOverloaded && attempt < 2) {
          Logger.log("Groq busy, retrying in " + waitSeconds[attempt] + "s");
          Utilities.sleep(waitSeconds[attempt] * 1000);
          continue;
        }
        return { error: result.error.message };
      }

      var text = result.choices[0].message.content.trim();
      var clean = text.replace(/```json|```/g, "").trim();
      var parsed = JSON.parse(clean);
      return { entries: Array.isArray(parsed) ? parsed : [parsed] };

    } catch (e) {
      if (attempt < 2) {
        Utilities.sleep(waitSeconds[attempt] * 1000);
      } else {
        return { error: e.toString() };
      }
    }
  }

  return { error: "Groq failed after 3 attempts. Try again later." };
}

// ============================================================
// LOG TO SHEET — with improved duplicate detection
// Columns: Date | Category | Amount | Note | Card
// ============================================================
function logToSheet(date, category, amount, note, card, sheet, existingData) {
  var normalizedAmount = parseFloat(parseFloat(amount).toFixed(2));
  var inputDate = new Date(date);
  var inputDateStr = Utilities.formatDate(inputDate, Session.getScriptTimeZone(), "yyyy-MM-dd");

  for (var i = 1; i < existingData.length; i++) {
    var rowAmt = parseFloat(parseFloat(existingData[i][2]).toFixed(2));
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
// FAILURE EMAIL — clean HTML with red accent
// ============================================================
function sendFailureEmail(subject, body, errorMsg) {
  var html = buildEmailWrapper("Budget Agent - Error",
    '<div style="background:#FFF3F3;border-left:4px solid #F44336;padding:16px;border-radius:4px;margin-bottom:16px;">' +
    '<p style="margin:0 0 8px;font-weight:600;color:#D32F2F;">Error</p>' +
    '<p style="margin:0;color:#333;font-family:monospace;font-size:13px;word-break:break-word;">' + errorMsg + '</p>' +
    '</div>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#666;font-weight:600;">Original Subject</p>' +
    '<p style="margin:0 0 16px;font-size:14px;color:#333;">' + subject + '</p>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#666;font-weight:600;">Original Body (truncated)</p>' +
    '<p style="margin:0;font-size:13px;color:#333;font-family:monospace;background:#f5f5f5;padding:12px;border-radius:4px;word-break:break-word;">' + body.substring(0, 300) + '</p>'
  );

  GmailApp.sendEmail(YOUR_EMAIL,
    "[FAILED] Budget Agent - paste error into Claude",
    "Budget Agent Error: " + errorMsg,
    { htmlBody: html }
  );
}

// ============================================================
// MAIN: PROCESS EXPENSE EMAILS
// ============================================================
function processExpenseEmails() {
  var labelName = "expense-processed";
  var processedLabel = GmailApp.getUserLabelByName(labelName);
  if (!processedLabel) processedLabel = GmailApp.createLabel(labelName);

  var threads = GmailApp.search("subject:expense -label:expense-processed newer_than:1d", 0, 20);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    Logger.log("Sheet not found: " + SHEET_NAME);
    GmailApp.sendEmail(YOUR_EMAIL, "[ERROR] Budget Agent", "Sheet '" + SHEET_NAME + "' not found. Check SHEET_NAME.");
    return;
  }
  var existingData = sheet.getDataRange().getValues();

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    thread.addLabel(processedLabel);

    var messages = thread.getMessages();
    for (var m = 0; m < messages.length; m++) {
      var message = messages[m];
      var subject = message.getSubject();
      var body = message.getPlainBody();
      var emailText = ("Subject: " + subject + "\n\n" + body).substring(0, 1500);

      var result = parseWithGroq(emailText);

      if (result.error) {
        sendFailureEmail(subject, body, result.error);
        Logger.log("Failed: " + result.error);
        continue;
      }

      if (!result.entries || result.entries.length === 0) {
        sendFailureEmail(subject, body, "No entries found in email.");
        continue;
      }

      var loggedItems = [];

      for (var e = 0; e < result.entries.length; e++) {
        var clean = sanitizeEntry(result.entries[e]);
        if (!clean) {
          Logger.log("Invalid entry skipped: " + JSON.stringify(result.entries[e]));
          continue;
        }
        try {
          var wasLogged = logToSheet(clean.date, clean.category, clean.amount, clean.note, clean.card, sheet, existingData);
          if (wasLogged) {
            loggedItems.push(clean);
            Logger.log("Logged: " + clean.date + " | " + clean.category + " | $" + clean.amount + " | " + clean.note + " | " + clean.card);
          }
        } catch (err) {
          sendFailureEmail(subject, body, "Sheet write failed: " + err.toString());
        }
      }

      // Send ONE combined HTML confirmation email
      if (loggedItems.length > 0) {
        var total = 0;
        var tableRows = "";
        for (var i = 0; i < loggedItems.length; i++) {
          var entry = loggedItems[i];
          var color = CATEGORY_COLORS[entry.category] || "#607D8B";
          var bgColor = i % 2 === 0 ? "#ffffff" : "#f9f9f9";
          var confidenceFlag = entry.confidence === "low"
            ? ' <span style="color:#FF9800;font-size:12px;">(uncertain)</span>'
            : '';
          total += parseFloat(entry.amount);

          tableRows += '<tr style="background:' + bgColor + ';">' +
            '<td style="padding:10px 12px;border-bottom:1px solid #eee;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-right:8px;vertical-align:middle;"></span>' +
            entry.category + '</td>' +
            '<td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;">$' + parseFloat(entry.amount).toFixed(2) + '</td>' +
            '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;">' + entry.card + '</td>' +
            '<td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;">' + entry.note + confidenceFlag + '</td>' +
            '</tr>';
        }

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
          '<td style="padding:12px;color:#fff;font-weight:700;">$' + total.toFixed(2) + '</td>' +
          '<td colspan="2" style="padding:12px;"></td>' +
          '</tr></table>' +
          buildViewSheetButton();

        var html = buildEmailWrapper("Expenses Logged", bodyHtml);
        var plainFallback = loggedItems.map(function(e) {
          return e.category + " | $" + parseFloat(e.amount).toFixed(2) + " | " + e.card + " | " + e.note;
        }).join("\n") + "\nTotal: $" + total.toFixed(2);

        GmailApp.sendEmail(YOUR_EMAIL,
          loggedItems.length + " expense" + (loggedItems.length > 1 ? "s" : "") + " logged - $" + total.toFixed(2) + " total",
          plainFallback,
          { htmlBody: html }
        );
      } else {
        Logger.log("All entries were duplicates or invalid. No email sent.");
      }
    }
  }
}

// ============================================================
// SPENDING ALERT: 20%+ over last month (min $10 threshold)
// ============================================================
function checkSpendingAlerts() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();

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
    var alertRows = "";
    for (var k = 0; k < alerts.length; k++) {
      var a = alerts[k];
      var clr = CATEGORY_COLORS[a.category] || "#607D8B";
      alertRows += '<tr>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;">' +
        '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + clr + ';margin-right:8px;vertical-align:middle;"></span>' +
        a.category + '</td>' +
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

    GmailApp.sendEmail(YOUR_EMAIL,
      "[ALERT] Spending up 20%+ in " + alerts.length + " categor" + (alerts.length > 1 ? "ies" : "y"),
      alertPlain,
      { htmlBody: alertHtml }
    );
  }
}

// ============================================================
// MONTHLY REPORT — HTML with horizontal bar charts
// ============================================================
function sendMonthlyReport() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var monthName = Utilities.formatDate(now, Session.getScriptTimeZone(), "MMMM yyyy");

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();

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

  var netSavings = totalIncome - totalExpenses;

  // Sort categories by amount descending
  var sortedCategories = Object.entries(categories).sort(function(a, b) { return b[1] - a[1]; });
  var maxAmount = sortedCategories.length > 0 ? sortedCategories[0][1] : 1;

  // Build horizontal bar chart
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
      '<span style="font-size:14px;font-weight:500;color:#333;">' + cat + '</span>' +
      '<span style="float:right;font-size:14px;font-weight:600;color:#333;">$' + amt.toFixed(2) + ' <span style="color:#999;font-weight:400;">(' + displayPct + '%)</span></span>' +
      '</div>' +
      '<div style="background:#f0f0f0;border-radius:6px;height:24px;overflow:hidden;">' +
      '<div style="background:' + color + ';height:100%;width:' + pct + '%;border-radius:6px;min-width:20px;"></div>' +
      '</div></div>';
  }

  // Build card breakdown
  var cardRows = "";
  var sortedCards = Object.entries(cardTotals).sort(function(a, b) { return b[1] - a[1]; });
  for (var d = 0; d < sortedCards.length; d++) {
    var cardName = sortedCards[d][0];
    var cardAmt = sortedCards[d][1];
    var cardPct = ((cardAmt / totalExpenses) * 100).toFixed(1);
    cardRows += '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">' + cardName + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;font-weight:600;">$' + cardAmt.toFixed(2) + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#999;">' + cardPct + '%</td>' +
      '</tr>';
  }

  // Summary section
  var savingsColor = netSavings >= 0 ? "#4CAF50" : "#F44336";
  var savingsLabel = netSavings >= 0 ? "On track" : "Over budget";
  var savingsBg = netSavings >= 0 ? "#E8F5E9" : "#FFEBEE";

  var reportBody =
    // Summary cards
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

    // Bar chart
    '<h2 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#333;">Expenses by Category</h2>' +
    (barChart || '<p style="color:#999;font-size:14px;">No expenses this month.</p>') +

    // Card breakdown
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

  GmailApp.sendEmail(YOUR_EMAIL,
    "Budget Report - " + monthName,
    reportPlain,
    { htmlBody: reportHtml }
  );
}

// ============================================================
// DAILY CHECK — monthly report on 1st, alerts on Monday
// ============================================================
function dailyCheck() {
  var now = new Date();
  if (now.getDate() === 1) sendMonthlyReport();
  if (now.getDay() === 1) checkSpendingAlerts();
}
