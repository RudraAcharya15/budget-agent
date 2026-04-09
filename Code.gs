// ============================================================
// BUDGET AGENT — Groq Powered
// ============================================================

const SHEET_ID = "YOUR_SHEET_ID";
const SHEET_NAME = "YOUR_SHEET_NAME";
const YOUR_EMAIL = "YOUR_EMAIL@gmail.com";
const GROQ_API_KEY = "YOUR_GROQ_API_KEY";

// ============================================================
// GROQ: PARSE ALL EXPENSES FROM EMAIL
// ============================================================
function parseWithGroq(emailText) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  const prompt = `You are a budget tracking assistant. Extract ALL expenses or income entries from this email and return ONLY a JSON array, no other text, no markdown, no backticks.

Today's date: ${today}

Categories: Grocery, Restaurant, Clothing, Transport, Entertainment, Income, Other

Cards:
- "amex" or "american express" or "ame x" → "Amex"
- "cibc" → "CIBC"
- "cash" or "debit" → "Cash"
- nothing mentioned → "Unknown"

Rules:
- Extract EVERY separate expense or income item mentioned
- If no date mentioned, use today's date
- Amount must always be a positive number
- Note should be a clean short description of what/where
- confidence: "high" if category is clear, "low" if uncertain

Return exactly this format (array, even if only one item):
[{"date":"yyyy-MM-dd","category":"one of the 7 categories","amount":0.00,"note":"short description","card":"Amex or CIBC or Cash or Unknown","confidence":"high or low"}]

Email text:
${emailText}`;

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const payload = {
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: 1000
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": "Bearer " + GROQ_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const waitSeconds = [5, 10, 15];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const result = JSON.parse(response.getContentText());

      if (result.error) {
        const msg = result.error.message || "";
        const isOverloaded = msg.includes("rate limit") || msg.includes("overloaded") || result.error.code === 429;
        if (isOverloaded && attempt < 2) {
          Logger.log(`⏳ Groq busy, retrying in ${waitSeconds[attempt]}s`);
          Utilities.sleep(waitSeconds[attempt] * 1000);
          continue;
        }
        return { error: result.error.message };
      }

      const text = result.choices[0].message.content.trim();
      const clean = text.replace(/\`\`\`json|\`\`\`/g, "").trim();
      const parsed = JSON.parse(clean);
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
// LOG TO SHEET — with duplicate detection
// Columns: Date | Category | Amount | Note | Card
// ============================================================
function logToSheet(date, category, amount, note, card) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  const normalizedAmount = parseFloat(parseFloat(amount).toFixed(2));
  const inputDate = new Date(date);
  const inputDateStr = Utilities.formatDate(inputDate, Session.getScriptTimeZone(), "yyyy-MM-dd");

  for (let i = 1; i < data.length; i++) {
    const rowAmt = parseFloat(parseFloat(data[i][2]).toFixed(2));
    let rowDateStr = "";
    try {
      rowDateStr = Utilities.formatDate(new Date(data[i][0]), Session.getScriptTimeZone(), "yyyy-MM-dd");
    } catch(e) { continue; }

    if (rowDateStr === inputDateStr && rowAmt === normalizedAmount) {
      Logger.log(`⚠️ Duplicate skipped: ${inputDateStr} | $${amount}`);
      return false;
    }
  }

  sheet.appendRow([inputDateStr, category, normalizedAmount, note, card || "Unknown"]);
  return true;
}

// ============================================================
// FAILURE EMAIL — with debug info to paste into Claude
// ============================================================
function sendFailureEmail(subject, body, errorMsg) {
  GmailApp.sendEmail(YOUR_EMAIL,
    "❌ Budget Agent Failed — paste error into Claude",
    `BUDGET AGENT DEBUG\n\nError: ${errorMsg}\n\nOriginal subject: ${subject}\nOriginal body: ${body}\n\nPaste this into Claude to fix it.`
  );
}

// ============================================================
// MAIN: PROCESS EXPENSE EMAILS
// ============================================================
function processExpenseEmails() {
  const labelName = "expense-processed";
  let processedLabel = GmailApp.getUserLabelByName(labelName);
  if (!processedLabel) processedLabel = GmailApp.createLabel(labelName);

  const threads = GmailApp.search("subject:expense -label:expense-processed newer_than:1d", 0, 20);

  for (const thread of threads) {
    // Label IMMEDIATELY — prevents re-processing if script crashes
    thread.addLabel(processedLabel);

    for (const message of thread.getMessages()) {
      const subject = message.getSubject();
      const body = message.getPlainBody();
      const emailText = `Subject: ${subject}\n\n${body}`.substring(0, 1500);

      const result = parseWithGroq(emailText);

      if (result.error) {
        sendFailureEmail(subject, body, result.error);
        Logger.log("❌ Failed: " + result.error);
        continue;
      }

      if (!result.entries || result.entries.length === 0) {
        sendFailureEmail(subject, body, "No entries found in email.");
        continue;
      }

      const loggedItems = [];

      for (const entry of result.entries) {
        if (!entry.amount) continue;
        try {
          const wasLogged = logToSheet(entry.date, entry.category, entry.amount, entry.note, entry.card);
          if (wasLogged) {
            loggedItems.push(entry);
            Logger.log(`✅ Logged: ${entry.date} | ${entry.category} | $${entry.amount} | ${entry.note} | ${entry.card}`);
          }
        } catch (e) {
          sendFailureEmail(subject, body, "Sheet write failed: " + e.toString());
        }
      }

      // Send ONE combined confirmation email
      if (loggedItems.length > 0) {
        const emojis = {
          "Grocery": "🛒", "Restaurant": "🍽️", "Transport": "🚗",
          "Clothing": "👕", "Entertainment": "🎬", "Income": "💰", "Other": "📦"
        };
        const cardEmojis = {
          "Amex": "💳 Amex", "CIBC": "💳 CIBC", "Cash": "💵 Cash", "Unknown": "❓ Unknown"
        };

        let total = 0;
        let rows = "";
        for (const entry of loggedItems) {
          const emoji = emojis[entry.category] || "📦";
          const cardLabel = cardEmojis[entry.card] || "❓ Unknown";
          const flag = entry.confidence === "low" ? " ⚠️" : "";
          rows += `  ${emoji} ${entry.category.padEnd(13)} $${parseFloat(entry.amount).toFixed(2).padStart(7)}  ${cardLabel}  ${entry.note}${flag}\n`;
          total += parseFloat(entry.amount);
        }

        GmailApp.sendEmail(YOUR_EMAIL,
          `✅ ${loggedItems.length} expense${loggedItems.length > 1 ? "s" : ""} logged — $${total.toFixed(2)} total`,
          `Logged to Budget Tracker:\n\n${rows}\n  ────────────────────────────\n  TOTAL   $${total.toFixed(2)}\n\nView: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`
        );
      } else {
        Logger.log("⚠️ All entries were duplicates. No email sent.");
      }
    }
  }
}

// ============================================================
// SPENDING ALERT: 20%+ over last month
// ============================================================
function checkSpendingAlerts() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
  const lastMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;

  const thisMonthTotals = {};
  const lastMonthTotals = {};

  for (let i = 1; i < data.length; i++) {
    const category = data[i][1];
    const amount = parseFloat(data[i][2]) || 0;
    if (category === "Income") continue;

    let rowDate;
    try { rowDate = new Date(data[i][0]); } catch(e) { continue; }

    const m = rowDate.getMonth();
    const y = rowDate.getFullYear();

    if (m === thisMonth && y === thisYear)
      thisMonthTotals[category] = (thisMonthTotals[category] || 0) + amount;
    if (m === lastMonth && y === lastMonthYear)
      lastMonthTotals[category] = (lastMonthTotals[category] || 0) + amount;
  }

  const alerts = [];
  for (const [cat, thisAmt] of Object.entries(thisMonthTotals)) {
    const lastAmt = lastMonthTotals[cat];
    if (!lastAmt) continue;
    const pct = ((thisAmt - lastAmt) / lastAmt) * 100;
    if (pct >= 20)
      alerts.push(`  ${cat}: $${thisAmt.toFixed(2)} this month vs $${lastAmt.toFixed(2)} last month (+${pct.toFixed(0)}%)`);
  }

  if (alerts.length > 0) {
    GmailApp.sendEmail(YOUR_EMAIL,
      `⚠️ Budget Alert: Spending up 20%+ in ${alerts.length} categor${alerts.length > 1 ? "ies" : "y"}`,
      `More than last month:\n\n${alerts.join("\n")}\n\nView: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`
    );
  }
}

// ============================================================
// MONTHLY REPORT
// ============================================================
function sendMonthlyReport() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthName = Utilities.formatDate(now, Session.getScriptTimeZone(), "MMMM yyyy");

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  const categories = {};
  const cardTotals = {};
  let totalIncome = 0;
  let totalExpenses = 0;

  for (let i = 1; i < data.length; i++) {
    let rowDate;
    try { rowDate = new Date(data[i][0]); } catch(e) { continue; }
    if (rowDate.getFullYear() !== year || rowDate.getMonth() !== month) continue;

    const category = data[i][1];
    const amount = parseFloat(data[i][2]) || 0;
    const card = data[i][4] || "Unknown";

    if (category === "Income") {
      totalIncome += amount;
    } else {
      totalExpenses += amount;
      categories[category] = (categories[category] || 0) + amount;
      cardTotals[card] = (cardTotals[card] || 0) + amount;
    }
  }

  const netSavings = totalIncome - totalExpenses;
  let biggestCat = "N/A", biggestAmt = 0;
  for (const [cat, amt] of Object.entries(categories)) {
    if (amt > biggestAmt) { biggestAmt = amt; biggestCat = cat; }
  }

  let breakdown = "";
  for (const [cat, amt] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(Math.max(1, Math.round((amt / totalExpenses) * 20)));
    breakdown += `  ${cat.padEnd(15)} $${amt.toFixed(2).padStart(8)}  ${bar}\n`;
  }

  let cardBreakdown = "";
  for (const [card, amt] of Object.entries(cardTotals).sort((a, b) => b[1] - a[1])) {
    cardBreakdown += `  ${card.padEnd(10)} $${amt.toFixed(2).padStart(8)}\n`;
  }

  GmailApp.sendEmail(YOUR_EMAIL,
    `📊 Budget Report — ${monthName}`,
    `BUDGET REPORT — ${monthName}\n${"=".repeat(45)}\n\nEXPENSES BY CATEGORY\n${breakdown || "  None."}\n  ${"─".repeat(41)}\n  TOTAL SPENT      $${totalExpenses.toFixed(2)}\n\nSPENDING BY CARD\n${cardBreakdown || "  None."}\n\nINCOME\n  Total Income     $${totalIncome.toFixed(2)}\n\nSUMMARY\n  Net Savings      $${netSavings.toFixed(2)}  ${netSavings >= 0 ? "✅ On track" : "⚠️ Over budget"}\n  Biggest spend:   ${biggestCat} ($${biggestAmt.toFixed(2)})\n\n${"=".repeat(45)}\nBudget Tracker`
  );
}

// ============================================================
// DAILY CHECK — monthly report + Monday alerts
// ============================================================
function dailyCheck() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getMonth() !== now.getMonth()) sendMonthlyReport();
  if (now.getDay() === 1) checkSpendingAlerts();
}
