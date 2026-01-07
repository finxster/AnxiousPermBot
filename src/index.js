export default {
  // Initialize history inside the module
  history: {
    lastCheck: null,
    weeklyChecks: [],
    totalChecks: 0
  },

  async fetch(request, env, ctx) {
    // Initialize history for this request if needed
    if (!this.history) {
      this.history = {
        lastCheck: null,
        weeklyChecks: [],
        totalChecks: 0
      };
    }

    if (request.method === 'GET') {
      return this.renderInterface();
    }

    if (request.method === 'POST') {
      return await this.processRequest(request, env);
    }

    return new Response('Method not allowed', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log(`⏰ Scheduled trigger at: ${event.scheduledTime}`);
    
    // Initialize history for scheduled execution
    if (!this.history) {
      this.history = {
        lastCheck: null,
        weeklyChecks: [],
        totalChecks: 0
      };
    }
    
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday...
    
    try {
      // Sunday: Weekly report
      if (dayOfWeek === 0) {
        await this.sendWeeklyReport(env);
      } 
      // Monday to Saturday: Daily report
      else {
        await this.sendDailyReport(env);
      }
      
      console.log('✅ Scheduled task executed successfully');
    } catch (error) {
      console.error(`❌ Error in scheduled task: ${error.message}`);
    }
  },

  // ========== MAIN FUNCTIONS ==========
  
  async sendDailyReport(env) {
    console.log('📅 Sending daily report...');
    
    const data = await this.fetchPERMData(env);
    const analysis = await this.analyzeChanges(data);
    const message = await this.formatDailyMessage(data, analysis);
    
    await this.sendToMultipleTelegramChats(env, message);
    
    // Update history
    this.updateHistory(data, 'daily');
  },

  async sendWeeklyReport(env) {
    console.log('📊 Sending weekly report...');
    
    const currentData = await this.fetchPERMData(env);
    const weeklyMessage = await this.formatWeeklyMessage(currentData);
    
    await this.sendToMultipleTelegramChats(env, weeklyMessage);
    
    // Reset weekly history
    this.history.weeklyChecks = [];
    this.history.totalChecks++;
  },

  // ========== MULTIPLE TELEGRAM CHATS ==========

  async sendToMultipleTelegramChats(env, message) {
    // Get chat IDs from environment variable (comma-separated)
    const chatIds = this.parseChatIds(env.TELEGRAM_CHAT_ID);
    
    if (chatIds.length === 0) {
      throw new Error('No Telegram chat IDs configured');
    }

    console.log(`📱 Sending to ${chatIds.length} chat(s): ${chatIds.join(', ')}`);
    
    // Send to all chats in parallel
    const sendPromises = chatIds.map(chatId => 
      this.sendToSingleTelegramChat(env.TELEGRAM_BOT_TOKEN, chatId, message)
    );
    
    const results = await Promise.allSettled(sendPromises);
    
    // Check results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    console.log(`✅ Sent to ${successful} chat(s), ❌ failed for ${failed} chat(s)`);
    
    // If all failed, throw error
    if (failed === chatIds.length) {
      const firstError = results.find(r => r.status === 'rejected');
      throw new Error(`Failed to send to all chats: ${firstError?.reason?.message || 'Unknown error'}`);
    }
    
    return {
      total: chatIds.length,
      successful,
      failed
    };
  },

  async sendToSingleTelegramChat(botToken, chatId, message) {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }),
    });
    
    const result = await response.json();
    
    if (!result.ok) {
      throw new Error(`Chat ${chatId}: ${result.description || 'Unknown error'}`);
    }
    
    return { chatId, success: true };
  },

  parseChatIds(chatIdString) {
    if (!chatIdString) return [];
    
    // Split by comma and clean up
    return chatIdString
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
  },

  // ========== ANALYSIS FUNCTIONS ==========

  async analyzeChanges(newData) {
    const analysis = {
      improvedPosition: false,
      timeChange: null,
      alerts: []
    };
    
    // Compare with last check
    if (this.history.lastCheck) {
      const { position: oldPos, remainingDays: oldDays } = this.history.lastCheck;
      const { adjusted_queue_position: newPos, remaining_days: newDays } = newData.queue_analysis;
      
      // 1. Queue position analysis
      if (newPos < oldPos) {
        const improvement = oldPos - newPos;
        const percentage = (improvement / oldPos * 100).toFixed(1);
        analysis.improvedPosition = true;
        analysis.positionImprovement = {
          amount: improvement,
          percentage: percentage
        };
        
        if (improvement > 1000) {
          analysis.alerts.push(`🚀 MOVED UP ${improvement.toLocaleString()} positions in queue!`);
        }
      }
      
      // 2. Remaining time analysis
      const dayDifference = oldDays - newDays;
      if (Math.abs(dayDifference) >= 3) {
        analysis.timeChange = dayDifference;
        if (dayDifference > 0) {
          analysis.alerts.push(`⏱️ Gained ${dayDifference} days in estimate!`);
        } else {
          analysis.alerts.push(`⚠️ Lost ${Math.abs(dayDifference)} days in estimate`);
        }
      }
      
      // 3. Special milestones
      if (newDays <= 30 && oldDays > 30) {
        analysis.alerts.push(`🎯 ENTERED FINAL MONTH!`);
      } else if (newDays <= 90 && oldDays > 90) {
        analysis.alerts.push(`📌 ENTERED FINAL QUARTER!`);
      }
    }
    
    return analysis;
  },

  updateHistory(data, type) {
    const record = {
      timestamp: new Date().toISOString(),
      date: data.submit_date,
      position: data.queue_analysis.adjusted_queue_position,
      remainingDays: data.remaining_days,
      estimatedDate: data.estimated_completion_date
    };
    
    this.history.lastCheck = record;
    
    if (type === 'daily') {
      this.history.weeklyChecks.push(record);
    }
    
    // Keep only last 7 days in memory
    if (this.history.weeklyChecks.length > 7) {
      this.history.weeklyChecks.shift();
    }
  },

  // ========== FORMATTING FUNCTIONS ==========

  async formatDailyMessage(data, analysis) {
    const { estimated_completion_date, submit_date, confidence_level, remaining_days } = data;
    const { current_backlog, adjusted_queue_position, weekly_processing_rate, estimated_queue_wait_weeks } = data.queue_analysis;
    
    const estimatedDate = this.formatDate(estimated_completion_date);
    const submitDate = this.formatDate(submit_date);
    const confidence = Math.round(confidence_level * 100);
    
    let message = `*📅 DAILY REPORT - ${this.formatDate(new Date().toISOString())}*

*Estimated Date:* 🗓️ *${estimatedDate}* (${confidence}% confidence)
*Submit Date:* 📋 ${submitDate}
*Days Remaining:* ⏱️ ${remaining_days} days

*📊 Queue Position:*
• Current Position: #${adjusted_queue_position.toLocaleString()}
• Ahead in Queue: ${current_backlog.toLocaleString()} cases
• Processing Rate: ${weekly_processing_rate.toLocaleString()}/week
• Estimated Wait: ~${estimated_queue_wait_weeks.toFixed(1)} weeks`;

    // Add alerts if any
    if (analysis.alerts.length > 0) {
      message += `\n\n*🔔 ALERTS:*\n`;
      analysis.alerts.forEach(alert => {
        message += `• ${alert}\n`;
      });
    }
    
    // Add comparative analysis
    if (analysis.positionImprovement) {
      message += `\n*📈 VS LAST CHECK:*`;
      message += `\n• Position: ${analysis.positionImprovement.amount.toLocaleString()} less`;
      message += `\n• Improvement: ${analysis.positionImprovement.percentage}%`;
    }
    
    message += `\n\n#PERMDaily #${data.employer_first_letter}Queue`;
    
    return message;
  },

  async formatWeeklyMessage(currentData) {
    if (this.history.weeklyChecks.length === 0) {
      return this.formatDailyMessage(currentData, { alerts: [] });
    }
    
    const { employer_first_letter } = currentData;
    const week = this.history.weeklyChecks;
    
    let message = `*📊 WEEKLY SUMMARY - Letter ${employer_first_letter}*\n`;
    message += `_Period: ${this.formatDate(week[0].timestamp)} to ${this.formatDate(new Date().toISOString())}_\n\n`;
    
    // Progress table
    message += `*📈 WEEKLY PROGRESS:*\n`;
    message += '```\n';
    message += 'Day      Position    Days Left\n';
    message += '------------------------------\n';
    
    week.forEach((check, index) => {
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(check.timestamp).getDay()];
      message += `${day.padEnd(6)} #${check.position.toLocaleString().padEnd(10)} ${check.remainingDays.toString().padEnd(4)} days\n`;
    });
    message += '```\n\n';
    
    // Statistics
    const first = week[0];
    const last = week[week.length - 1];
    const positionProgress = first.position - last.position;
    const daysProgress = first.remainingDays - last.remainingDays;
    
    message += `*📊 WEEKLY STATISTICS:*\n`;
    message += `• Queue progress: ${positionProgress > 0 ? '+' : ''}${positionProgress.toLocaleString()} positions\n`;
    message += `• Time gain/loss: ${daysProgress > 0 ? '+' : ''}${daysProgress} days\n`;
    message += `• Daily average: ${(positionProgress / week.length).toFixed(0).toLocaleString()} positions/day\n`;
    message += `• Trend: ${positionProgress > 0 ? '⏫ Accelerating' : '⏬ Decelerating'}\n`;
    
    // Insights
    message += `\n*💡 INSIGHTS:*\n`;
    if (positionProgress > 1000) {
      message += `• Great week! Processing above average\n`;
    }
    if (last.remainingDays < 100) {
      message += `• You're in the final third of the process\n`;
    }
    if (daysProgress > 7) {
      message += `• Significant time gain this week\n`;
    }
    
    message += `\n#PERMWeekly #${employer_first_letter}Summary #Week${this.history.totalChecks + 1}`;
    
    return message;
  },

  // ========== HELPER FUNCTIONS ==========

  async fetchPERMData(env) {
    const response = await fetch(
      'https://perm-backend-production.up.railway.app/api/predictions/from-date',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submit_date: "2024-12-19",
          employer_first_letter: "A"
        }),
      }
    );
    
    if (!response.ok) throw new Error(`PERM API failed: ${response.status}`);
    return await response.json();
  },

  // Old function kept for compatibility (not used internally anymore)
  async sendToTelegram(env, message) {
    return this.sendToMultipleTelegramChats(env, message);
  },

  formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  },

  renderInterface() {
    const totalChecks = this.history?.totalChecks || 0;
    const weeklyChecks = this.history?.weeklyChecks?.length || 0;
    
    // Parse chat IDs for display
    const chatIds = this.parseChatIds(process.env?.TELEGRAM_CHAT_ID || '');
    
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>PERM Tracker Pro</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            max-width: 900px; 
            margin: 40px auto; 
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          }
          .container {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          }
          h1 {
            color: #667eea;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.5em;
          }
          .card { 
            background: #f8f9fa; 
            padding: 20px; 
            border-radius: 10px; 
            margin: 20px 0;
            border-left: 4px solid #667eea;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          .card h3 {
            margin-top: 0;
            color: #333;
          }
          button { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 8px; 
            cursor: pointer; 
            font-size: 16px; 
            margin: 5px;
            transition: all 0.3s ease;
            font-weight: 600;
          }
          button:hover { 
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
          }
          button.secondary {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          }
          button.secondary:hover {
            box-shadow: 0 5px 15px rgba(245, 87, 108, 0.4);
          }
          .status { 
            margin-top: 20px; 
            padding: 15px; 
            border-radius: 8px; 
            background: #f8f9fa;
            min-height: 50px;
          }
          .chat-list { 
            margin-top: 10px; 
            padding: 10px; 
            background: #e9ecef; 
            border-radius: 5px; 
          }
          .chat-item { 
            padding: 5px; 
            font-family: monospace; 
          }
          #reportResult {
            margin-top: 20px;
            padding: 25px;
            background: white;
            border-radius: 12px;
            border: 2px solid #667eea;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            display: none;
          }
          #reportResult.show {
            display: block;
            animation: fadeIn 0.5s ease;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .report-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 1.3em;
            font-weight: bold;
          }
          .report-section {
            margin: 20px 0;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #667eea;
          }
          .report-section h4 {
            margin-top: 0;
            color: #667eea;
          }
          .report-item {
            padding: 8px 0;
            display: flex;
            justify-content: space-between;
            border-bottom: 1px solid #e0e0e0;
          }
          .report-item:last-child {
            border-bottom: none;
          }
          .report-item .label {
            font-weight: 600;
            color: #555;
          }
          .report-item .value {
            color: #333;
            font-weight: bold;
          }
          .alert-box {
            background: #fff3cd;
            border: 2px solid #ffc107;
            border-radius: 8px;
            padding: 15px;
            margin: 10px 0;
            color: #856404;
          }
          .alert-box.success {
            background: #d4edda;
            border-color: #28a745;
            color: #155724;
          }
          .alert-box.info {
            background: #d1ecf1;
            border-color: #17a2b8;
            color: #0c5460;
          }
          .weekly-table {
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
            background: white;
            border-radius: 8px;
            overflow: hidden;
          }
          .weekly-table th {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px;
            text-align: left;
          }
          .weekly-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #e0e0e0;
          }
          .weekly-table tr:hover {
            background: #f8f9fa;
          }
          .button-group {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 PERM Tracker Pro</h1>
          
          <div class="card">
            <h3>🔔 Active Schedule</h3>
            <p><strong>Daily:</strong> Monday to Saturday, 6:00 AM UTC</p>
            <p><strong>Weekly:</strong> Sunday, 6:00 AM UTC</p>
          </div>
          
          <div class="card">
            <h3>⚡ Test Schedulers (Send to Telegram)</h3>
            <p>Test the scheduled reports by sending them to Telegram:</p>
            <div class="button-group">
              <button onclick="test('daily')">Test Daily Report</button>
              <button onclick="test('weekly')">Test Weekly Report</button>
            </div>
          </div>
          
          <div class="card">
            <h3>📊 Generate & View Reports</h3>
            <p>Generate reports and view them here on the web page:</p>
            <div class="button-group">
              <button class="secondary" onclick="generateReport('daily')">Generate Daily Report</button>
              <button class="secondary" onclick="generateReport('weekly')">Generate Weekly Report</button>
            </div>
          </div>
          
          <div class="card">
            <h3>📋 Current Status</h3>
            <p>Submit Date: <strong>December 19, 2024</strong></p>
            <p>Employer Letter: <strong>A</strong></p>
            <p>Total Checks: <strong>${totalChecks}</strong></p>
            <p>Checks This Week: <strong>${weeklyChecks}</strong></p>
            <p>Telegram Chats: <strong>${chatIds.length}</strong></p>
            ${chatIds.length > 0 ? `
              <div class="chat-list">
                ${chatIds.map((id, index) => 
                  `<div class="chat-item">${index + 1}. ${id}</div>`
                ).join('')}
              </div>
            ` : '<p style="color: #dc3545;">⚠️ No Telegram chat IDs configured</p>'}
          </div>
          
          <div id="status" class="status"></div>
          
          <div id="reportResult"></div>
        </div>
        
        <script>
          async function test(type) {
            const status = document.getElementById('status');
            status.innerHTML = '⏳ Processing...';
            
            try {
              const response = await fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: type })
              });
              
              const text = await response.text();
              status.innerHTML = response.ok ? 
                '✅ ' + text : 
                '❌ Error: ' + text;
            } catch (error) {
              status.innerHTML = '❌ Error: ' + error.message;
            }
          }
          
          async function generateReport(type) {
            const status = document.getElementById('status');
            const reportResult = document.getElementById('reportResult');
            
            status.innerHTML = '⏳ Generating report...';
            reportResult.innerHTML = '';
            reportResult.classList.remove('show');
            
            try {
              const response = await fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: type, display: true })
              });
              
              if (!response.ok) {
                throw new Error(await response.text());
              }
              
              const html = await response.text();
              reportResult.innerHTML = html;
              reportResult.classList.add('show');
              status.innerHTML = '✅ Report generated successfully!';
              
              // Scroll to report
              reportResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (error) {
              status.innerHTML = '❌ Error: ' + error.message;
            }
          }
        </script>
      </body>
      </html>
    `, { headers: { 'Content-Type': 'text/html' } });
  },

  async processRequest(request, env) {
    try {
      const body = await request.json().catch(() => ({}));
      
      // Check if this is a display request (show in web page)
      if (body.display) {
        if (body.type === 'weekly') {
          const html = await this.generateWeeklyReportHTML(env);
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        } else {
          const html = await this.generateDailyReportHTML(env);
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        }
      }
      
      // Otherwise, send to Telegram
      if (body.type === 'weekly') {
        await this.sendWeeklyReport(env);
        return new Response('✅ Weekly report sent to all chats!');
      } else {
        await this.sendDailyReport(env);
        return new Response('✅ Daily report sent to all chats!');
      }
    } catch (error) {
      return new Response(`❌ Error: ${error.message}`, { status: 500 });
    }
  },

  async generateDailyReportHTML(env) {
    const data = await this.fetchPERMData(env);
    const analysis = await this.analyzeChanges(data);
    
    // Update history
    this.updateHistory(data, 'daily');
    
    const { estimated_completion_date, submit_date, confidence_level, remaining_days } = data;
    const { current_backlog, adjusted_queue_position, weekly_processing_rate, estimated_queue_wait_weeks } = data.queue_analysis;
    
    const estimatedDate = this.formatDate(estimated_completion_date);
    const submitDate = this.formatDate(submit_date);
    const confidence = Math.round(confidence_level * 100);
    const today = this.formatDate(new Date().toISOString());
    
    let html = `
      <div class="report-header">
        📅 Daily Report - ${today}
      </div>
      
      <div class="report-section">
        <h4>📊 Key Information</h4>
        <div class="report-item">
          <span class="label">🗓️ Estimated Completion Date:</span>
          <span class="value">${estimatedDate}</span>
        </div>
        <div class="report-item">
          <span class="label">🎯 Confidence Level:</span>
          <span class="value">${confidence}%</span>
        </div>
        <div class="report-item">
          <span class="label">📋 Submit Date:</span>
          <span class="value">${submitDate}</span>
        </div>
        <div class="report-item">
          <span class="label">⏱️ Days Remaining:</span>
          <span class="value">${remaining_days} days</span>
        </div>
      </div>
      
      <div class="report-section">
        <h4>📈 Queue Analysis</h4>
        <div class="report-item">
          <span class="label">Current Position:</span>
          <span class="value">#${adjusted_queue_position.toLocaleString()}</span>
        </div>
        <div class="report-item">
          <span class="label">Cases Ahead in Queue:</span>
          <span class="value">${current_backlog.toLocaleString()}</span>
        </div>
        <div class="report-item">
          <span class="label">Processing Rate:</span>
          <span class="value">${weekly_processing_rate.toLocaleString()}/week</span>
        </div>
        <div class="report-item">
          <span class="label">Estimated Wait:</span>
          <span class="value">~${estimated_queue_wait_weeks.toFixed(1)} weeks</span>
        </div>
      </div>
    `;
    
    // Add alerts if any
    if (analysis.alerts.length > 0) {
      html += `
        <div class="report-section">
          <h4>🔔 Alerts</h4>
      `;
      analysis.alerts.forEach(alert => {
        const alertClass = alert.includes('MOVED UP') || alert.includes('Gained') ? 'success' : 
                          alert.includes('Lost') ? '' : 'info';
        html += `<div class="alert-box ${alertClass}">${alert}</div>`;
      });
      html += `</div>`;
    }
    
    // Add comparative analysis
    if (analysis.positionImprovement) {
      html += `
        <div class="report-section">
          <h4>📊 Comparison with Last Check</h4>
          <div class="alert-box success">
            <strong>Position Improvement:</strong> ${analysis.positionImprovement.amount.toLocaleString()} positions better (${analysis.positionImprovement.percentage}% improvement)
          </div>
        </div>
      `;
    }
    
    return html;
  },

  async generateWeeklyReportHTML(env) {
    const currentData = await this.fetchPERMData(env);
    
    if (this.history.weeklyChecks.length === 0) {
      // If no weekly history, show daily report instead
      return this.generateDailyReportHTML(env);
    }
    
    const { employer_first_letter } = currentData;
    const week = this.history.weeklyChecks;
    
    const firstDate = this.formatDate(week[0].timestamp);
    const lastDate = this.formatDate(new Date().toISOString());
    
    let html = `
      <div class="report-header">
        📊 Weekly Summary - Letter ${employer_first_letter}
      </div>
      
      <div class="report-section">
        <h4>📅 Period</h4>
        <div class="report-item">
          <span class="label">From:</span>
          <span class="value">${firstDate}</span>
        </div>
        <div class="report-item">
          <span class="label">To:</span>
          <span class="value">${lastDate}</span>
        </div>
      </div>
      
      <div class="report-section">
        <h4>📈 Weekly Progress</h4>
        <table class="weekly-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Position</th>
              <th>Days Left</th>
            </tr>
          </thead>
          <tbody>
    `;
    
    week.forEach((check, index) => {
      const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(check.timestamp).getDay()];
      html += `
            <tr>
              <td>${day}</td>
              <td>#${check.position.toLocaleString()}</td>
              <td>${check.remainingDays} days</td>
            </tr>
      `;
    });
    
    html += `
          </tbody>
        </table>
      </div>
    `;
    
    // Statistics
    const first = week[0];
    const last = week[week.length - 1];
    const positionProgress = first.position - last.position;
    const daysProgress = first.remainingDays - last.remainingDays;
    const dailyAverage = (positionProgress / week.length).toFixed(0);
    
    html += `
      <div class="report-section">
        <h4>📊 Weekly Statistics</h4>
        <div class="report-item">
          <span class="label">Queue Progress:</span>
          <span class="value">${positionProgress > 0 ? '+' : ''}${positionProgress.toLocaleString()} positions</span>
        </div>
        <div class="report-item">
          <span class="label">Time Gain/Loss:</span>
          <span class="value">${daysProgress > 0 ? '+' : ''}${daysProgress} days</span>
        </div>
        <div class="report-item">
          <span class="label">Daily Average:</span>
          <span class="value">${dailyAverage} positions/day</span>
        </div>
        <div class="report-item">
          <span class="label">Trend:</span>
          <span class="value">${positionProgress > 0 ? '⏫ Accelerating' : '⏬ Decelerating'}</span>
        </div>
      </div>
    `;
    
    // Insights
    const insights = [];
    if (positionProgress > 1000) {
      insights.push('🎉 Great week! Processing above average');
    }
    if (last.remainingDays < 100) {
      insights.push('🎯 You\'re in the final third of the process');
    }
    if (daysProgress > 7) {
      insights.push('⚡ Significant time gain this week');
    }
    
    if (insights.length > 0) {
      html += `
        <div class="report-section">
          <h4>💡 Insights</h4>
      `;
      insights.forEach(insight => {
        html += `<div class="alert-box info">${insight}</div>`;
      });
      html += `</div>`;
    }
    
    return html;
  }
};