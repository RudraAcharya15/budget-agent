# Budget Agent

AI-powered budget tracker using Google Apps Script, Gmail, Google Sheets, and Groq LLM. Email your expenses and they get automatically parsed, validated, and logged to a spreadsheet.

## What It Does

- **Parses expense emails** — send an email with "expense" in the subject, and Groq LLM extracts date, category, amount, card, and note
- **Logs to Google Sheets** — entries are written to your spreadsheet with duplicate detection
- **Validates LLM output** — category/card allowlisting, amount caps ($50k), date validation
- **HTML email confirmations** — clean, styled confirmation with a table of logged expenses
- **Weekly spending alerts** — notifies you on Mondays if any category is up 20%+ vs last month (HTML styled)
- **Monthly reports** — auto-generates a spending breakdown with horizontal bar charts on the 1st of each month

## Prerequisites

- A Google account
- A [Groq API key](https://console.groq.com/) (free tier works)
- A Google Sheet with columns: `Date | Category | Amount | Note | Card`

## Setup

1. **Create a Google Sheet** with headers in row 1: `Date`, `Category`, `Amount`, `Note`, `Card`

2. **Copy the Sheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit
   ```

3. **Get a Groq API key** from [console.groq.com](https://console.groq.com/)

4. **Create a new Apps Script project** at [script.google.com](https://script.google.com/)

5. **Paste the code** from `Code.gs` into the editor

6. **Set your config values** at the top of the file:
   ```javascript
   const SHEET_ID = "your-sheet-id-here";
   const SHEET_NAME = "Sheet1";  // or whatever your sheet tab is named
   const YOUR_EMAIL = "you@gmail.com";
   const GROQ_API_KEY = "gsk_your_key_here";
   ```

   > **Tip:** For better security, use Script Properties instead of hardcoding:
   > Go to Project Settings > Script Properties and add each value there, then use:
   > ```javascript
   > const GROQ_API_KEY = PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
   > ```

7. **Set up a trigger** to run automatically:
   - In the Apps Script editor, go to **Triggers** (clock icon in sidebar)
   - Add trigger: `processExpenseEmails` → Time-driven → Every 5 minutes (or your preference)
   - Add trigger: `dailyCheck` → Time-driven → Day timer → 8:00 AM (or your preference)

8. **Authorize the script** when prompted (it needs Gmail and Sheets access)

## Usage

Send yourself (or have others send to you) an email with **"expense"** in the subject line:

```
Subject: expense

Coffee at Starbucks $5.50 on amex
Uber to airport $32.00
Groceries at Costco $147.85 cibc
```

The agent will parse all items, log them to your sheet, and email you a confirmation.

## Categories

Grocery, Restaurant, Clothing, Transport, Entertainment, Income, Other

## Supported Cards

Amex, CIBC, Cash, Unknown

## License

[MIT](LICENSE)
