# Anxious Perm Bot

A Cloudflare Worker that automatically tracks PERM (Program Electronic Review Management) case processing times using https://permupdate.com API and sends daily/weekly reports via Telegram.

## Features

- Daily Reports: Monday to Saturday at 6:00 AM UTC
- Weekly Summaries: Sundays at 6:00 AM UTC
- Multiple Recipients: Send to multiple Telegram chats simultaneously
- Smart Analysis: Compare progress with previous reports
- Web Interface: Dashboard to monitor status and trigger manual reports
- Automatic Scheduling: Powered by Cloudflare Cron Triggers

## Prerequisites

1. A Telegram account
2. A Cloudflare account

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for @BotFather
2. Send /newbot command
3. Choose a name for your bot (e.g., "PERM Tracker")
4. Choose a username (must end with bot, e.g., perm_tracker_bot)
5. SAVE the API token provided by BotFather

### 2. Get Your Chat ID(s)

1. Send a message to your new bot (click "START")
2. For single chat: Use your personal chat ID
3. For multiple chats: Get each chat ID and separate them with commas

To get Chat ID:
- Send any message to your bot
- Visit: https://api.telegram.org/botYOUR_TOKEN/getUpdates
- Find chat.id in the response

### 3. Deploy to Cloudflare

1. Go to Cloudflare Workers: https://dash.cloudflare.com/?to=/:account/workers-and-pages
2. Click "Create application" -> "Create Worker"
3. Paste the code from worker.js
4. Click "Save and Deploy"

### 4. Configure Environment Variables

In Cloudflare Dashboard, go to your Worker -> Settings -> Variables:

Variable | Description | Example
---------|-------------|---------
TELEGRAM_BOT_TOKEN | Your bot token from BotFather | 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID | Chat ID(s), comma-separated | 123456789,987654321

### 5. Configure KV Storage for Reports

To enable weekly summaries and daily report comparisons:

1. In Cloudflare Dashboard, go to Workers & Pages -> KV
2. Click "Create a namespace" 
3. Name it: `PERM_REPORT_HISTORY`
4. Go to your Worker -> Settings -> Variables -> KV Namespace Bindings
5. Click "Add binding"
6. Set Variable name: `REPORT_HISTORY`
7. Select the KV namespace you created
8. Click "Save"

**Important:** KV storage is required for:
- **Daily Report Comparisons**: Day-to-day delta indicators (🔴▲/🟢▼) that show changes from the previous day
- **Weekly Summaries**: Historical data for the weekly progress table

Without KV storage:
- Daily reports will still be sent, but won't show comparison deltas (will display "No comparison data available")
- Weekly reports will show a "no data available" message

### 6. Set Up Cron Trigger

1. In your Worker, go to "Triggers"
2. Click "Add Cron Trigger"
3. Set schedule to: 0 6 * * * (6:00 AM UTC daily)
4. Save

## Custom Configuration for permupdate.com

This worker uses the predictability API from https://permupdate.com. To configure:

### Custom Parameters:

1. Submit Date: Your PERM submission date (format: YYYY-MM-DD)
2. Employer First Letter: First letter of employer name

Edit these lines in the code:

```javascript
body: JSON.stringify({
  submit_date: "2024-12-19",    // YOUR DATE HERE
  employer_first_letter: "A"     // YOUR LETTER HERE
}),
```

### API Endpoint Used:

```
POST https://perm-backend-production.up.railway.app/api/predictions/from-date
```

## Understanding the Reports

### Daily Report (Monday-Saturday)

Daily reports now include **day-to-day comparisons** with delta indicators:

```
DAILY REPORT - Dec 28, 2024

Estimated Date: 🗓️ May 29, 2026 (80% confidence) 🟢▼ -1 days
Submit Date: 📋 Dec 19, 2024
Days Remaining: ⏱️ 152 days 🟢▼ -1 days

📊 Queue Position:
• Current Position: #45,600 🟢▼ -500 positions
• Ahead in Queue: 133,325 cases 🟢▼ -500 cases
• Processing Rate: 2,099/week 🔴▲ +49 /week
• Estimated Wait: ~21.7 weeks 🟢▼ -0.4 weeks

ALERTS:
• MOVED UP 500 positions in queue!

VS LAST CHECK:
• Position: 500 less
• Improvement: 1.1%
```

**Delta Indicators Explained:**
- 🔴▲ Red up arrow: Value increased from previous day
- 🟢▼ Green down arrow: Value decreased from previous day
- ↔️ No change: Value stayed the same

**Note:** On Mondays, the comparison is made with Saturday's data (Sunday reports are weekly summaries only).

If no previous day's data is available (first report or new deployment), you'll see:
```
ℹ️ No comparison data available
This is the first report or previous day's data is not yet stored.
```

### Weekly Report (Sunday)

```
WEEKLY SUMMARY - Letter A
Period: Dec 22, 2024 to Dec 28, 2024

WEEKLY PROGRESS:
Day      Position    Days Left
------------------------------
Mon      #46,100    157 days
Tue      #45,900    156 days
Wed      #45,800    155 days
Thu      #45,700    154 days
Fri      #45,650    153 days
Sat      #45,600    152 days

WEEKLY STATISTICS:
• Queue progress: +500 positions
• Time gain/loss: +5 days
• Daily average: 83 positions/day
• Trend: Accelerating

INSIGHTS:
• Great week! Processing above average
• You're in the final third of the process
```

## Web Interface

Access your Worker URL (e.g., https://perm-tracker.your-username.workers.dev) to see:

- Dashboard: Current status and statistics
- Manual Triggers: Test daily/weekly reports
- Chat List: See all configured Telegram chats
- History: View this week's tracking data

### Testing the Comparison Feature

To test the new day-to-day comparison feature:

1. **First Day**: Send a daily report - it will show "No comparison data available"
2. **Second Day**: Send another daily report - it will show deltas comparing with the first day
3. **Monday Test**: On Monday, the comparison will automatically use Saturday's data instead of Sunday

You can use the "Test Daily Report" button in the web interface or wait for the scheduled cron job to trigger.

**Note**: The comparison data is stored in Cloudflare KV with keys like `daily_snapshot_2024-12-28`. Each day's snapshot includes:
- Estimated completion date
- Days remaining
- Queue position
- Cases ahead
- Processing rate
- Estimated wait time

## Customization

### Modify Schedule

Update the Cron Trigger in Cloudflare:
- Daily at 9 AM: 0 9 * * *
- Every 6 hours: 0 */6 * * *
- Custom: Use crontab guru https://crontab.guru/

### Add More Analysis

Extend the analyzeChanges() function to add:
- Custom alerts based on progress thresholds
- Additional milestone notifications
- Comparison with historical averages

## Troubleshooting

### No Messages Received
1. Check Cloudflare Worker logs
2. Verify Telegram bot token and chat IDs
3. Ensure bot is started in Telegram
4. Check if messages are blocked by Telegram

### Web Interface Not Loading
1. Visit Worker URL directly
2. Check browser console for errors
3. Verify Worker is deployed and running

### Scheduled Reports Not Sending
1. Check Cloudflare Cron Trigger configuration
2. Verify timezone (uses UTC)
3. Check Worker logs for errors

## Project Structure

```
perm-tracker/
├── worker.js          # Main Cloudflare Worker code
├── README.md          # This documentation
```

## Privacy & Security

- No personal data stored
- Only processes public PERM API data
- Telegram bot only sends messages, doesn't receive commands
- All communication uses HTTPS

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file

## Acknowledgments

- https://permupdate.com for predictability API
- Cloudflare Workers for serverless hosting
- Telegram Bot API for notifications

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review Cloudflare Worker logs
3. Open a GitHub issue

---

Happy Tracking!

Note: This tool provides estimates only. Always check official USCIS sources for accurate processing times.