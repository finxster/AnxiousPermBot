export default {
  // Initialize history inside the module
  history: {
    lastCheck: null,
    totalChecks: 0
  },

  // Constants
  WEEKDAY_NAMES: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  
  // Thresholds for alerts and insights
  THRESHOLD_SIGNIFICANT_PROGRESS: 1000,
  THRESHOLD_FINAL_THIRD: 100,
  THRESHOLD_SIGNIFICANT_TIME_GAIN: 7,

  async fetch(request, env, ctx) {
    // Initialize history for this request if needed
    if (!this.history) {
      this.history = {
        lastCheck: null,
        totalChecks: 0
      };
    }

    if (request.method === 'GET') {
      return this.renderInterface(env);
    }

    if (request.method === 'POST') {
      return await this.processRequest(request, env);
    }

    return new Response('Method not allowed', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log(`⏰ Scheduled trigger at:  ${event.scheduledTime}`);
    
    // Initialize history for scheduled execution
    if (!this.history) {
      this.history = {
        lastCheck: null,
        totalChecks: 0
      };
    }
    
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday... (using UTC time)
    
    try {
      // Sunday:  Weekly report
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
    
    // Fetch previous day's data for comparison
    const previousData = await this.fetchPreviousDayData(env);
    
    const analysis = await this.analyzeChanges(data);
    const message = await this.formatDailyMessage(data, analysis, previousData);
    
    await this.sendToMultipleTelegramChats(env, message);
    
    // Update history
    this.updateHistory(data, 'daily');
    
    // Store today's snapshot for future comparison (if KV is available)
    if (env.REPORT_HISTORY) {
      await this.storeDailySnapshot(env, data);
      await this.storeDailyReportData(env, data);
    }
  },

  async storeDailyReportData(env, data) {
    try {
      const reportData = {
        timestamp: new Date().toISOString(),
        position: data.queue_analysis.adjusted_queue_position,
        remainingDays: data.remaining_days
      };
      
      // Get existing reports
      const existingReportsJson = await env.REPORT_HISTORY.get('daily_reports');
      let reports = existingReportsJson ? JSON.parse(existingReportsJson) : [];
      
      // Add new report
      reports.push(reportData);
      
      // Keep only last 7 days (store 7 to have history, return 6 for weekly summary)
      if (reports.length > 7) {
        reports = reports.slice(-7);
      }
      
      // Store back
      await env.REPORT_HISTORY.put('daily_reports', JSON.stringify(reports));
      console.log(`✅ Stored daily report data (${reports.length} reports in history)`);
    } catch (error) {
      console.error('❌ Error storing daily report data:', error.message);
      // Don't fail the entire operation if storage fails
    }
  },

  async storeDailySnapshot(env, data) {
    try {
      const today = new Date();
      const dateKey = this.getDateKey(today);
      
      const snapshot = {
        timestamp: today.toISOString(),
        dateKey: dateKey,
        estimatedDate: data.estimated_completion_date,
        remainingDays: data.remaining_days,
        position: data.queue_analysis.adjusted_queue_position,
        casesAhead: data.queue_analysis.current_backlog,
        processingRate: data.queue_analysis.weekly_processing_rate,
        estimatedWait: data.queue_analysis.estimated_queue_wait_weeks
      };
      
      await env.REPORT_HISTORY.put(`daily_snapshot_${dateKey}`, JSON.stringify(snapshot));
      console.log(`✅ Stored daily snapshot for ${dateKey}`);
    } catch (error) {
      console.error('❌ Error storing daily snapshot:', error.message);
      // Don't fail the entire operation if storage fails
    }
  },

  async fetchPreviousDayData(env) {
    console.log('📥 Fetching previous day data for comparison...');
    
    if (!env.REPORT_HISTORY) {
      console.warn('⚠️ REPORT_HISTORY KV namespace not configured');
      return null;
    }
    
    try {
      const today = new Date();
      const previousDate = this.getPreviousReportDate(today);
      const dateKey = this.getDateKey(previousDate);
      
      const snapshotJson = await env.REPORT_HISTORY.get(`daily_snapshot_${dateKey}`);
      
      if (!snapshotJson) {
        console.warn(`⚠️ No snapshot found for ${dateKey}`);
        return null;
      }
      
      const snapshot = JSON.parse(snapshotJson);
      console.log(`✅ Found previous day snapshot for ${dateKey}`);
      return snapshot;
    } catch (error) {
      console.error('❌ Error fetching previous day data:', error.message);
      return null;
    }
  },

  getDateKey(date) {
    // Returns date in YYYY-MM-DD format
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  getPreviousReportDate(today) {
    // Clone the date to avoid mutating the original
    const previousDate = new Date(today);
    const dayOfWeek = today.getUTCDay();
    
    // If today is Monday (1), compare with Saturday (skip Sunday)
    if (dayOfWeek === 1) {
      // Go back 2 days to get Saturday
      previousDate.setUTCDate(today.getUTCDate() - 2);
    } else {
      // For other days, just go back 1 day
      previousDate.setUTCDate(today.getUTCDate() - 1);
    }
    
    return previousDate;
  },

  calculateDeltas(currentData, previousData) {
    if (!previousData) {
      return null;
    }

    const deltas = {
      estimatedDate: this.calculateDateDelta(currentData.estimated_completion_date, previousData.estimatedDate),
      remainingDays: this.calculateNumberDelta(
        currentData.remaining_days,
        previousData.remainingDays,
        'days',
        true  // lower is better
      ),
      position: this.calculateNumberDelta(
        currentData.queue_analysis.adjusted_queue_position,
        previousData.position,
        'positions',
        true  // lower is better
      ),
      casesAhead: this.calculateNumberDelta(
        currentData.queue_analysis.current_backlog,
        previousData.casesAhead,
        'cases',
        true  // lower is better
      ),
      processingRate: this.calculateNumberDelta(
        currentData.queue_analysis.weekly_processing_rate,
        previousData.processingRate,
        '/week',
        false  // higher is better
      ),
      estimatedWait: this.calculateNumberDelta(
        currentData.queue_analysis.estimated_queue_wait_weeks,
        previousData.estimatedWait,
        'weeks',
        true  // lower is better
      )
    };

    return deltas;
  },

  calculateDateDelta(currentDateStr, previousDateStr) {
    const current = new Date(currentDateStr);
    const previous = new Date(previousDateStr);
    const diffMs = current - previous;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return { arrow: '↔️', text: 'no change', value: 0 };
    } else if (diffDays > 0) {
      // Date moved forward - increase (red up arrow)
      return { arrow: '🔴▲', text: `+${diffDays} days`, value: diffDays };
    } else {
      // Date moved earlier - decrease (green down arrow)
      return { arrow: '🟢▼', text: `${diffDays} days`, value: diffDays };
    }
  },

  calculateNumberDelta(current, previous, unit, lowerIsBetter) {
    const diff = current - previous;
    
    if (diff === 0) {
      return { arrow: '↔️', text: 'no change', value: 0 };
    }
    
    // Arrow based on direction: increase = 🔴▲, decrease = 🟢▼
    const arrow = diff > 0 ? '🔴▲' : '🟢▼';
    const sign = diff > 0 ? '+' : '';
    const formattedDiff = typeof current === 'number' && current > 1000 
      ? diff.toLocaleString() 
      : diff.toFixed(unit === 'weeks' || unit === '/week' ? 1 : 0);
    
    return { 
      arrow: arrow, 
      text: `${sign}${formattedDiff} ${unit}`,
      value: diff 
    };
  },

  async fetchRecentReportsFromStorage(env) {
    console.log('📥 Fetching recent reports from storage...');
    
    if (!env.REPORT_HISTORY) {
      console.warn('⚠️ REPORT_HISTORY KV namespace not configured');
      return [];
    }
    
    try {
      const reportsJson = await env.REPORT_HISTORY.get('daily_reports');
      
      if (!reportsJson) {
        console.warn('⚠️ No report history found in storage');
        return [];
      }
      
      const reports = JSON.parse(reportsJson);
      console.log(`✅ Found ${reports.length} recent daily reports in storage`);
      
      // Return last 6 daily reports (from Monday through Saturday) for the weekly summary
      return reports.slice(-6);
    } catch (error) {
      console.error('❌ Error fetching report history:', error.message);
      return [];
    }
  },

  async sendWeeklyReport(env) {
    console.log('📊 Sending weekly report...');
    
    const currentData = await this.fetchPERMData(env);
    const weeklyData = await this.fetchRecentReportsFromStorage(env);
    const weeklyMessage = await this.formatWeeklyMessage(currentData, weeklyData);
    
    await this.sendToMultipleTelegramChats(env, weeklyMessage);
    
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
      this.sendToSingleTelegramChat(env. TELEGRAM_BOT_TOKEN, chatId, message)
    );
    
    const results = await Promise.allSettled(sendPromises);
    
    // Check results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results. filter(r => r.status === 'rejected').length;
    
    console.log(`✅ Sent to ${successful} chat(s), ❌ failed for ${failed} chat(s)`);
    
    // If all failed, throw error
    if (failed === chatIds.length) {
      const firstError = results.find(r => r.status === 'rejected');
      throw new Error(`Failed to send to all chats: ${firstError || 'Unknown error'}`);
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
        text:  message,
        parse_mode:  'Markdown',
        disable_web_page_preview: true
      }),
    });
    
    const result = await response.json();
    
    if (! result.ok) {
      throw new Error(`Chat ${chatId}:  ${result.description || 'Unknown error'}`);
    }
    
    return { chatId, success: true };
  },

  parseChatIds(chatIdString) {
    if (!chatIdString) return [];
    
    // Split by comma and clean up
    return chatIdString
      .split(',')
      .map(id => id.trim())
      .filter(id => id. length > 0);
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
        
        if (improvement > this.THRESHOLD_SIGNIFICANT_PROGRESS) {
          analysis.alerts.push(`🚀 MOVED UP ${improvement.toLocaleString()} positions in queue! `);
        }
      }
      
      // 2. Remaining time analysis
      const dayDifference = oldDays - newDays;
      if (Math.abs(dayDifference) >= 3) {
        analysis.timeChange = dayDifference;
        if (dayDifference > 0) {
          analysis.alerts. push(`⏱️ Gained ${dayDifference} days in estimate! `);
        } else {
          analysis.alerts. push(`⚠️ Lost ${Math.abs(dayDifference)} days in estimate`);
        }
      }
      
      // 3. Special milestones
      if (newDays <= 30 && oldDays > 30) {
        analysis.alerts.push(`🎯 ENTERED FINAL MONTH!`);
      } else if (newDays <= 90 && oldDays > 90) {
        analysis.alerts. push(`📌 ENTERED FINAL QUARTER!`);
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
  },

  // ========== FORMATTING FUNCTIONS ==========

  async formatDailyMessage(data, analysis, previousData = null) {
    const { estimated_completion_date, submit_date, confidence_level, remaining_days } = data;
    const { current_backlog, adjusted_queue_position, weekly_processing_rate, estimated_queue_wait_weeks } = data. queue_analysis;
    
    const estimatedDate = this.formatDate(estimated_completion_date);
    const submitDate = this.formatDate(submit_date);
    const confidence = Math.round(confidence_level * 100);
    
    // Calculate deltas if previous data is available
    const deltas = this.calculateDeltas(data, previousData);
    
    let message = `*📅 DAILY REPORT - ${this.formatDate(new Date().toISOString())}*

*Estimated Date: * 🗓️ *${estimatedDate}* (${confidence}% confidence)`;
    
    // Add delta for estimated date if available
    if (deltas && deltas.estimatedDate) {
      message += ` ${deltas.estimatedDate.arrow} ${deltas.estimatedDate.text}`;
    }
    
    message += `
*Submit Date:* 📋 ${submitDate}
*Days Remaining:* ⏱️ ${remaining_days} days`;
    
    // Add delta for remaining days if available
    if (deltas && deltas.remainingDays) {
      message += ` ${deltas.remainingDays.arrow} ${deltas.remainingDays.text}`;
    }
    
    // Calculate and add journey metrics
    const journey = this.calculateJourneyMetrics(data);
    const progressBar = this.generateProgressBar(journey.progressPercentage);
    
    message += `

*🛤️ Journey Progress:*
• Days Passed: ${journey.daysPassed} days
• Remaining: ${journey.remainingDays} days
• Total Journey: ${journey.totalJourneyDays} days

Progress: ${journey.progressPercentage}%
${progressBar}
    
*📊 Queue Position:*
• Current Position: #${adjusted_queue_position.toLocaleString()}`;
    
    // Add delta for position if available
    if (deltas && deltas.position) {
      message += ` ${deltas.position.arrow} ${deltas.position.text}`;
    }
    
    message += `
• Ahead in Queue: ${current_backlog. toLocaleString()} cases`;
    
    // Add delta for cases ahead if available
    if (deltas && deltas.casesAhead) {
      message += ` ${deltas.casesAhead.arrow} ${deltas.casesAhead.text}`;
    }
    
    message += `
• Processing Rate: ${weekly_processing_rate.toLocaleString()}/week`;
    
    // Add delta for processing rate if available
    if (deltas && deltas.processingRate) {
      message += ` ${deltas.processingRate.arrow} ${deltas.processingRate.text}`;
    }
    
    message += `
• Estimated Wait: ~${estimated_queue_wait_weeks. toFixed(1)} weeks`;
    
    // Add delta for estimated wait if available
    if (deltas && deltas.estimatedWait) {
      message += ` ${deltas.estimatedWait.arrow} ${deltas.estimatedWait.text}`;
    }

    // Add alerts if any
    if (analysis.alerts. length > 0) {
      message += `\n\n*🔔 ALERTS:*\n`;
      analysis.alerts.forEach(alert => {
        message += `• ${alert}\n`;
      });
    }
    
    // Add comparative analysis
    if (analysis.positionImprovement) {
      message += `\n*📈 VS LAST CHECK:*`;
      message += `\n• Position:  ${analysis.positionImprovement. amount.toLocaleString()} less`;
      message += `\n• Improvement: ${analysis.positionImprovement.percentage}%`;
    }
    
    message += `\n\n#PERMDaily #${data.employer_first_letter}Queue`;
    
    return message;
  },

  async formatWeeklyMessage(currentData, weeklyData = []) {
    // If no weekly data from storage, return a message indicating insufficient data
    if (weeklyData.length === 0) {
      return `*📊 WEEKLY SUMMARY*\n\n_Unable to generate weekly report: No historical data found in storage._\n\nPlease ensure daily reports have been sent for at least a few days to generate a weekly summary.\n\n_Note: Report history storage requires the REPORT_HISTORY KV namespace to be configured._`;
    }
    
    const { employer_first_letter } = currentData;
    
    let message = `*📊 WEEKLY SUMMARY - Letter ${employer_first_letter}*\n`;
    message += `_Period: ${this.formatDate(weeklyData[0].timestamp)} to ${this.formatDate(new Date().toISOString())}_\n\n`;
    
    // Progress table
    message += `*📈 WEEKLY PROGRESS:*\n`;
    message += '```\n';
    message += 'Day      Position    Days Left\n';
    message += '------------------------------\n';
    
    weeklyData.forEach((check, index) => {
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(check.timestamp).getUTCDay()];
      message += `${day.padEnd(6)} #${check.position.toLocaleString().padEnd(10)} ${check.remainingDays.toString().padEnd(4)} days\n`;
    });
    message += '```\n\n';
    
    // Statistics
    const first = weeklyData[0];
    const last = weeklyData[weeklyData.length - 1];
    const positionProgress = first.position - last.position;
    const daysProgress = first.remainingDays - last.remainingDays;
    
    message += `*📊 WEEKLY STATISTICS:*\n`;
    message += `• Queue progress: ${positionProgress > 0 ? '+' : ''}${positionProgress.toLocaleString()} positions\n`;
    message += `• Time gain/loss: ${daysProgress > 0 ? '+' : ''}${daysProgress} days\n`;
    message += `• Daily average: ${(positionProgress / weeklyData.length).toFixed(0).toLocaleString()} positions/day\n`;
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

  // HTML escaping utility to prevent XSS
  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  calculateJourneyMetrics(data) {
    const { submit_date, estimated_completion_date, remaining_days } = data;
    
    // Calculate total journey days from submit_date to estimated_completion_date
    const submitDate = new Date(submit_date);
    const estimatedDate = new Date(estimated_completion_date);
    const totalJourneyDays = Math.round((estimatedDate - submitDate) / (1000 * 60 * 60 * 24));
    
    // Calculate days passed
    const daysPassed = totalJourneyDays - remaining_days;
    
    // Calculate progress percentage
    const progressPercentage = totalJourneyDays > 0 ? Math.round((daysPassed / totalJourneyDays) * 100) : 0;
    
    return {
      daysPassed,
      remainingDays: remaining_days,
      totalJourneyDays,
      progressPercentage
    };
  },

  generateProgressBar(progressPercentage) {
    // Generate a visual progress bar using Unicode block characters
    const filledBlocks = Math.floor(progressPercentage / 5); // 20 blocks for 100%
    const emptyBlocks = 20 - filledBlocks;
    const filled = '█'.repeat(filledBlocks);
    const empty = '░'.repeat(emptyBlocks);
    return `${filled}${empty}`;
  },

  renderInterface(env) {
    const totalChecks = this.history?.totalChecks || 0;
    
    // Parse chat IDs for display - use env parameter instead of process.env
    const chatIds = this.parseChatIds(env?.TELEGRAM_CHAT_ID || '');
    
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
            padding:  20px;
            background:  linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
            margin:  20px 0;
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
          button: hover { 
            transform: translateY(-2px);
            box-shadow:  0 5px 15px rgba(102, 126, 234, 0.4);
          }
          @media (prefers-reduced-motion: reduce) {
            button {
              transition: none;
            }
            button:hover {
              transform:  none;
            }
          }
          button. secondary {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          }
          button.secondary:hover {
            box-shadow: 0 5px 15px rgba(245, 87, 108, 0.4);
          }
          .status { 
            margin-top: 20px; 
            padding: 15px; 
            border-radius:  8px; 
            background: #f8f9fa;
            min-height: 50px;
          }
          .chat-list { 
            margin-top: 10px; 
            padding:  10px; 
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
          @media (prefers-reduced-motion: reduce) {
            #reportResult. show {
              animation: none;
            }
          }
          .report-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            border-radius:  8px;
            margin-bottom:  20px;
            font-size: 1.3em;
            font-weight: bold;
          }
          .report-section {
            margin:  20px 0;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #667eea;
          }
          .report-section h4 {
            margin-top:  0;
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
          .report-item . label {
            font-weight:  600;
            color: #555;
          }
          .report-item .value {
            color: #333;
            font-weight: bold;
          }
          .alert-box {
            background: #fff3cd;
            border: 2px solid #ffc107;
            border-radius:  8px;
            padding:  15px;
            margin: 10px 0;
            color: #856404;
          }
          .alert-box. success {
            background: #d4edda;
            border-color:  #28a745;
            color: #155724;
          }
          .alert-box. info {
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
            border-bottom:  1px solid #e0e0e0;
          }
          .weekly-table tr:hover {
            background: #f8f9fa;
          }
          .button-group {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
          }
          .progress-container {
            margin: 15px 0;
          }
          .progress-bar-wrapper {
            width: 100%;
            height: 30px;
            background: #e0e0e0;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
          }
          .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            border-radius: 15px;
            transition: width 0.5s ease;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding-right: 10px;
            color: white;
            font-weight: bold;
          }
          .progress-text {
            margin-top: 8px;
            text-align: center;
            font-weight: bold;
            color: #667eea;
            font-size: 1.1em;
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
            <p>Test the scheduled reports by sending them to Telegram: </p>
            <div class="button-group">
              <button onclick="test('daily')">Test Daily Report</button>
              <button onclick="test('weekly')">Test Weekly Report</button>
            </div>
          </div>
          
          <div class="card">
            <h3>📊 Generate & View Reports</h3>
            <p>Generate reports and view them here on the web page:</p>
            <div class="button-group">
              <button class="secondary" onclick="generateReport('daily')" aria-label="Generate and display daily PERM report">Generate Daily Report</button>
              <button class="secondary" onclick="generateReport('weekly')" aria-label="Generate and display weekly PERM report">Generate Weekly Report</button>
            </div>
          </div>
          
          <div class="card">
            <h3>📋 Current Status</h3>
            <p>Submit Date: <strong>December 19, 2024</strong></p>
            <p>Employer Letter: <strong>A</strong></p>
            <p>Total Checks: <strong>${totalChecks}</strong></p>
            <p>Telegram Chats: <strong>${chatIds.length}</strong></p>
            ${chatIds.length > 0 ? `
              <div class="chat-list">
                ${chatIds.map((id, index) => 
                  `<div class="chat-item">${index + 1}. ${this.escapeHtml(id)}</div>`
                ).join('')}
              </div>
            ` : '<p style="color: #dc3545;">⚠️ No Telegram chat IDs configured</p>'}
          </div>
          
          <div id="status" class="status"></div>
          
          <div id="reportResult" role="status" aria-live="polite" aria-atomic="true"></div>
        </div>
        
        <script>
          async function test(type) {
            const status = document.getElementById('status');
            status.innerHTML = '⏳ Processing...';
            
            try {
              const response = await fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type:  type })
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
            
            status. innerHTML = '⏳ Generating report...';
            reportResult.innerHTML = '';
            reportResult.classList.remove('show');
            
            try {
              const response = await fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: type, display: true })
              });
              
              if (!response.ok) {
                const errorText = await response.text();
                const statusMsg = response.status === 500 ? 'Server error' : 
                                 response.status === 503 ? 'Service unavailable' : 
                                 'Error (' + response.status + ')';
                throw new Error(statusMsg + ': ' + errorText);
              }
              
              const html = await response.text();
              reportResult.innerHTML = html;
              reportResult.classList.add('show');
              status.textContent = '✅ Report generated successfully!';
              
              // Scroll to report
              reportResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (error) {
              status.textContent = '❌ Error:  ' + error.message;
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
      
      // Validate type parameter
      const validTypes = ['daily', 'weekly'];
      const type = validTypes.includes(body.type) ? body.type : 'daily';
      
      // Check if this is a display request (show in web page)
      if (body.display) {
        let html;
        if (type === 'weekly') {
          html = await this.generateWeeklyReportHTML(env);
        } else {
          html = await this.generateDailyReportHTML(env);
        }
        return new Response(html, { headers: { 'Content-Type':  'text/html' } });
      }
      
      // Otherwise, send to Telegram
      if (type === 'weekly') {
        await this.sendWeeklyReport(env);
        return new Response('✅ Weekly report sent to all chats! ');
      } else {
        await this.sendDailyReport(env);
        return new Response('✅ Daily report sent to all chats!');
      }
    } catch (error) {
      // Set appropriate content type for errors
      const contentType = error.message.includes('HTML') ? 'text/html' : 'text/plain';
      return new Response(`❌ Error: ${error.message}`, { 
        status: 500,
        headers: { 'Content-Type': contentType }
      });
    }
  },

  /**
   * Generates the daily PERM status report as an HTML string. 
   *
   * This function fetches the latest PERM data, performs change analysis,
   * updates the in-memory history for daily checks, and builds a formatted
   * HTML report suitable for rendering in a browser.
   *
   * @param {any} env - Execution environment object containing configuration
   *   and bindings required to fetch and analyze PERM data.
   * @returns {Promise<string>} A promise that resolves to the generated HTML
   *   markup for the daily report.
   *
   * @sideeffect Updates this.history via updateHistory with the
   *   latest daily check data.
   */
  async generateDailyReportHTML(env) {
    const data = await this.fetchPERMData(env);
    const previousData = await this.fetchPreviousDayData(env);
    const analysis = await this.analyzeChanges(data);
    
    // Update history
    this.updateHistory(data, 'daily');
    
    const { estimated_completion_date, submit_date, confidence_level, remaining_days } = data;
    const { current_backlog, adjusted_queue_position, weekly_processing_rate, estimated_queue_wait_weeks } = data. queue_analysis;
    
    const estimatedDate = this.formatDate(estimated_completion_date);
    const submitDate = this.formatDate(submit_date);
    const confidence = Math.round(confidence_level * 100);
    const today = this.formatDate(new Date().toISOString());
    
    // Calculate deltas if previous data is available
    const deltas = this.calculateDeltas(data, previousData);
    
    let html = `
      <div class="report-header">
        📅 Daily Report - ${today}
      </div>
      
      <div class="report-section">
        <h4>📊 Key Information</h4>
        <div class="report-item">
          <span class="label">🗓️ Estimated Completion Date:</span>
          <span class="value">${estimatedDate}`;
    
    if (deltas && deltas.estimatedDate) {
      html += ` ${deltas.estimatedDate.arrow} ${this.escapeHtml(deltas.estimatedDate.text)}`;
    }
    
    html += `</span>
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
          <span class="value">${remaining_days} days`;
    
    if (deltas && deltas.remainingDays) {
      html += ` ${deltas.remainingDays.arrow} ${this.escapeHtml(deltas.remainingDays.text)}`;
    }
    
    html += `</span>
        </div>
      </div>
      
      <div class="report-section">
        <h4>🛤️ Journey Progress</h4>`;
    
    // Calculate journey metrics
    const journey = this.calculateJourneyMetrics(data);
    
    html += `
        <div class="report-item">
          <span class="label">Days Passed:</span>
          <span class="value">${journey.daysPassed} days</span>
        </div>
        <div class="report-item">
          <span class="label">Remaining:</span>
          <span class="value">${journey.remainingDays} days</span>
        </div>
        <div class="report-item">
          <span class="label">Total Journey:</span>
          <span class="value">${journey.totalJourneyDays} days</span>
        </div>
        <div class="progress-container" style="margin-top: 15px;">
          <div class="progress-bar-wrapper">
            <div class="progress-bar-fill" style="width: ${journey.progressPercentage}%"></div>
          </div>
          <div class="progress-text">${journey.progressPercentage}% Complete</div>
        </div>
      </div>
      
      <div class="report-section">
        <h4>📈 Queue Analysis</h4>
        <div class="report-item">
          <span class="label">Current Position:</span>
          <span class="value">#${adjusted_queue_position. toLocaleString()}`;
    
    if (deltas && deltas.position) {
      html += ` ${deltas.position.arrow} ${this.escapeHtml(deltas.position.text)}`;
    }
    
    html += `</span>
        </div>
        <div class="report-item">
          <span class="label">Cases Ahead in Queue:</span>
          <span class="value">${current_backlog.toLocaleString()}`;
    
    if (deltas && deltas.casesAhead) {
      html += ` ${deltas.casesAhead.arrow} ${this.escapeHtml(deltas.casesAhead.text)}`;
    }
    
    html += `</span>
        </div>
        <div class="report-item">
          <span class="label">Processing Rate:</span>
          <span class="value">${weekly_processing_rate.toLocaleString()}/week`;
    
    if (deltas && deltas.processingRate) {
      html += ` ${deltas.processingRate.arrow} ${this.escapeHtml(deltas.processingRate.text)}`;
    }
    
    html += `</span>
        </div>
        <div class="report-item">
          <span class="label">Estimated Wait: </span>
          <span class="value">~${estimated_queue_wait_weeks. toFixed(1)} weeks`;
    
    if (deltas && deltas.estimatedWait) {
      html += ` ${deltas.estimatedWait.arrow} ${this.escapeHtml(deltas.estimatedWait.text)}`;
    }
    
    html += `</span>
        </div>
      </div>
    `;
    
    // Add alerts if any
    if (analysis.alerts. length > 0) {
      html += `
        <div class="report-section">
          <h4>🔔 Alerts</h4>
      `;
      analysis.alerts.forEach(alert => {
        // Classify alert based on content
        const alertText = this.escapeHtml(alert);
        const lowerAlert = String(alert).toLowerCase();
        let alertClass = 'info';

        if (lowerAlert.includes('moved up') || lowerAlert.includes('gained')) {
          alertClass = 'success';
        } else if (lowerAlert.includes('lost')) {
          alertClass = '';  // Default warning color
        }

        html += `<div class="alert-box ${alertClass}">${alertText}</div>`;
      });
      html += `</div>`;
    }
    
    // Add comparative analysis
    if (analysis.positionImprovement) {
      html += `
        <div class="report-section">
          <h4>📊 Comparison with Last Check</h4>
          <div class="alert-box success">
            <strong>Position Improvement:</strong> ${analysis. positionImprovement. amount. toLocaleString()} positions better (${analysis.positionImprovement.percentage}% improvement)
          </div>
        </div>
      `;
    }
    
    return html;
  },

  /**
   * Generates an HTML weekly summary report for the current PERM data.
   *
   * This fetches recent daily reports from Cloudflare KV storage to build a
   * week-long view of position and days-left trends for the current employer
   * first-letter grouping. If no weekly history is available from storage, an
   * informational HTML message is returned explaining that weekly data is not
   * yet available.
   *
   * @param {any} env - Environment object passed in by the runtime, used by
   *   fetchPERMData to retrieve the latest PERM statistics.
   * @returns {Promise<string>} A promise that resolves to an HTML string
   *   representing the weekly report or an informational message when weekly
   *   data is not yet available.
   */
  async generateWeeklyReportHTML(env) {
    const currentData = await this.fetchPERMData(env);
    const weeklyData = await this.fetchRecentReportsFromStorage(env);
    
    if (weeklyData.length === 0) {
      // If no weekly history, show a message
      return `
        <div class="report-header">
          📊 Weekly Summary - Not Available
        </div>
        <div class="report-section">
          <div class="alert-box info">
            <strong>No weekly data available yet.</strong><br>
            Weekly reports require multiple daily reports to be stored. Please check back after the scheduled daily reports have run for several days.<br><br>
            <strong>Note:</strong> Report history storage requires the REPORT_HISTORY KV namespace to be configured in Cloudflare Workers.
          </div>
        </div>
      `;
    }
    
    const { employer_first_letter } = currentData;
    
    const firstDate = this.formatDate(weeklyData[0].timestamp);
    const lastDate = this.formatDate(new Date().toISOString());
    
    let html = `
      <div class="report-header">
        📊 Weekly Summary - Letter ${this.escapeHtml(employer_first_letter)}
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
    
    weeklyData.forEach((check, index) => {
      const day = this.WEEKDAY_NAMES[new Date(check.timestamp).getUTCDay()];
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
    const first = weeklyData[0];
    const last = weeklyData[weeklyData.length - 1];
    const positionProgress = first.position - last.position;
    const daysProgress = first.remainingDays - last.remainingDays;
    const dailyAverage = (positionProgress / weeklyData.length).toFixed(0);
    
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
    if (positionProgress > this.THRESHOLD_SIGNIFICANT_PROGRESS) {
      insights.push('🎉 Great week! Processing above average');
    }
    if (last.remainingDays < this.THRESHOLD_FINAL_THIRD) {
      insights.push('🎯 You\'re in the final third of the process');
    }
    if (daysProgress > this.THRESHOLD_SIGNIFICANT_TIME_GAIN) {
      insights.push('⚡ Significant time gain this week');
    }
    
    if (insights.length > 0) {
      html += `
        <div class="report-section">
          <h4>💡 Insights</h4>
      `;
      insights.forEach(insight => {
        html += `<div class="alert-box info">${this.escapeHtml(insight)}</div>`;
      });
      html += `</div>`;
    }
    
    return html;
  }
};
