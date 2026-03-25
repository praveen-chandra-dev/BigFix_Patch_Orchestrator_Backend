// src/mail/transport.js
const nodemailer = require("nodemailer");
const { splitEmails, escapeHtml } = require("../utils/http");

function toBool(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on"; 
}

function buildTransport(smtp) {
  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE,
    SMTP_USER, SMTP_PASSWORD, SMTP_ALLOW_SELF_SIGNED,
    SMTP_IGNORE_TLS, SMTP_REQUIRE_TLS, SMTP_TLS_REJECT_UNAUTH,
  } = smtp || {};

  const secure = toBool(SMTP_SECURE);
  const allowSelfSigned = toBool(SMTP_ALLOW_SELF_SIGNED);
  const ignoreTLS = toBool(SMTP_IGNORE_TLS);
  const requireTLS = toBool(SMTP_REQUIRE_TLS);
  const tlsRejectUnauth = typeof SMTP_TLS_REJECT_UNAUTH !== "undefined" ? toBool(SMTP_TLS_REJECT_UNAUTH) : !allowSelfSigned;

  const transportOpts = {
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure,
    ignoreTLS,
    requireTLS,
    tls: { rejectUnauthorized: tlsRejectUnauth },
  };
  if (SMTP_USER || SMTP_PASSWORD) {
    transportOpts.auth = { user: SMTP_USER, pass: SMTP_PASSWORD };
  }
  return nodemailer.createTransport(transportOpts);
}

// --- CSV PARSERS ---

function parseCsvRow(row) {
  let insideQuote = false; let entries = []; let current = '';
  for (let i = 0; i < row.length; i++) {
      if (row[i] === '"') {
          if (i + 1 < row.length && row[i+1] === '"') { current += '"'; i++; } else { insideQuote = !insideQuote; }
      } else if (row[i] === ',' && !insideQuote) { entries.push(current.trim()); current = ''; } 
      else { current += row[i]; }
  }
  entries.push(current.trim()); return entries;
}

function parsePrePatchMetrics(csvString) {
  if (!csvString) return { total: 0 };
  const lines = csvString.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return { total: 0 }; 
  return { total: lines.length - 1 }; 
}

function parsePostPatchMetrics(csvString) {
  if (!csvString) return { totalRows: 0, uniqueServers: 0, success: 0, failed: 0, pending: 0, topFailedPatches: [] };
  const lines = csvString.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return { totalRows: 0, uniqueServers: 0, success: 0, failed: 0, pending: 0, topFailedPatches: [] };

  const dataLines = lines.slice(1);
  let success = 0, failed = 0, pending = 0;
  const failedPatchesCount = {};
  const uniqueServersList = new Set();

  dataLines.forEach(line => {
    const parts = parseCsvRow(line);
    const serverName = parts[0] || "Unknown";
    const patchName = parts[1] || "Unknown Patch";
    const status = (parts[2] || "").toLowerCase();

    if (serverName !== "Unknown" && serverName !== "N/A") {
        uniqueServersList.add(serverName.toLowerCase().replace(/"/g, ''));
    }

    if (status.includes('success') || status.includes('fixed') || status.includes('completed')) { success++; } 
    else if (status.includes('fail') || status.includes('error')) {
      failed++;
      if (patchName && patchName.toLowerCase() !== "n/a") failedPatchesCount[patchName] = (failedPatchesCount[patchName] || 0) + 1;
    } else { pending++; }
  });

  const topFailed = Object.keys(failedPatchesCount).map(name => ({ name, count: failedPatchesCount[name] }))
    .sort((a, b) => b.count - a.count).slice(0, 3); 

  return { totalRows: dataLines.length, uniqueServers: uniqueServersList.size, success, failed, pending, topFailedPatches: topFailed };
}

// --- HTML EMAIL TEMPLATE RENDERER ---

function buildHtmlContent(data) {
  let topFailedHtml = '';
  if (data.TOP_FAILED_PATCHES && data.TOP_FAILED_PATCHES.length > 0) {
    topFailedHtml = `
      <div class="metrics" style="border-color: #fecaca; background-color: #fef2f2;">
        <h4 style="margin-top: 0; margin-bottom: 10px; color: #b71c1c;">Top Failing Patches (Errors)</h4>
        <table style="font-size: 13px;">
          ${data.TOP_FAILED_PATCHES.map(p => `<tr><td style="color: #555; padding-right: 15px;">${escapeHtml(p.name)}</td><td style="color: #b71c1c;">${p.count} failures</td></tr>`).join('')}
        </table>
      </div>
    `;
  }

  let patchesHtml = '';
  if (data.BASELINE_PATCHES && data.BASELINE_PATCHES.length > 0) {
    const topPatches = data.BASELINE_PATCHES.slice(0, 5);
    const moreCount = data.BASELINE_PATCHES.length - 5;
    patchesHtml = `
      <div class="metrics">
        <h4 style="margin-top: 0; margin-bottom: 10px; color: #005f9e;">Baseline Content (${data.BASELINE_PATCHES.length} Patches)</h4>
        <table style="font-size: 12px; border-collapse: collapse; width: 100%;">
          <tr style="color: #666; font-weight: bold; border-bottom: 1px solid #ddd;">
            <td style="padding-bottom: 6px;">Patch Name</td>
            <td style="padding-bottom: 6px; text-align: right; width: 80px;">Severity</td>
          </tr>
          ${topPatches.map(p => `
            <tr>
              <td style="color: #333; padding: 6px 15px 6px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(p.name)}</td>
              <td style="color: #555; text-align: right; padding: 6px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(p.severity)}</td>
            </tr>
          `).join('')}
        </table>
        ${moreCount > 0 ? `<div style="margin-top: 10px; font-size: 11px; color: #666;">...and ${moreCount} more (View the attached CSV for the full list, Source, and CVEs).</div>` : ''}
      </div>
    `;
  }

  const operationsRowHtml = data.TOTAL_OPERATIONS ? `<tr><td>Total Patch Operations</td><td>${data.TOTAL_OPERATIONS}</td></tr>` : '';

  return `
  <!DOCTYPE html>
  <html>
  <head>
  <meta charset="UTF-8">
  <title>${data.EMAIL_TITLE}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f4f6f8; font-family: Arial, Helvetica, sans-serif; }
    .container { width: 100%; padding: 20px 0; background-color: #f4f6f8; }
    .email-box { max-width: 700px; margin: auto; background: #ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); overflow: hidden;}
    .content { padding: 0 25px 25px 25px; color: #333333; font-size: 14px; line-height: 1.6; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 15px; margin: 15px 0; border-left: 4px solid #005f9e; }
    .summary table { width: 100%; border-collapse: collapse; }
    .summary td { padding: 6px 0; font-size: 13px; }
    .label { font-weight: bold; color: #475569; width: 35%; }
    .value { color: #0f172a; }
    .highlight { font-weight: bold; color: #005f9e; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
    .success { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .warning { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .danger  { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
    .metrics { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 4px; padding: 15px; margin: 15px 0; }
    .metrics table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .metrics td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
    .metrics td:last-child { text-align: right; font-weight: bold; }
  </style>
  </head>
  <body>
    <div class="container">
      <div class="email-box">
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 20px 25px; border-bottom: 3px solid #005f9e;">
          <tr>
            <td align="left" valign="middle" style="font-family: Arial, sans-serif;">
              <span style="color: #005f9e; font-size: 24px; font-weight: 900; letter-spacing: -0.5px;">HCL</span><span style="color: #555555; font-size: 24px; font-weight: 300; letter-spacing: -0.5px;">Software</span>
            </td>
            <td align="right" valign="middle" style="font-family: Arial, sans-serif; color: #475569; font-size: 16px; font-weight: bold;">
              BigFix Patch Setu
            </td>
          </tr>
        </table>

        <div class="content">
          <h2 style="color: #005f9e; margin-top: 25px; font-size: 20px;">${data.EMAIL_TITLE}</h2>
          <p>Hello Team,</p>
          <p>${data.INTRO_MESSAGE}</p>
          
          <div class="summary">
            <table>
              <tr><td class="label">Environment:</td><td class="value">${data.ENVIRONMENT}</td></tr>
              <tr><td class="label">Patch Name (Baseline):</td><td class="value">${data.BASELINE}</td></tr>
              <tr><td class="label">Scope (Group):</td><td class="value">${data.SCOPE}</td></tr>
              <tr><td class="label">Action ID:</td><td class="value">#${data.ACTION_ID}</td></tr>
              <tr><td class="label">Window / Time:</td><td class="value">${data.TIME_WINDOW}</td></tr>
              <tr><td class="label">Overall Status:</td><td class="value">${data.STATUS_BADGE}</td></tr>
            </table>
          </div>
          
          <div class="metrics">
            <table>
              <tr>
                <td>Unique Systems Targeted</td>
                <td>${data.UNIQUE_SYSTEMS}</td>
              </tr>
              ${operationsRowHtml}
              <tr>
                <td>Successfully Patched</td>
                <td><span style="color: #166534;">${data.PATCHED_COUNT}</span></td>
              </tr>
              <tr>
                <td>Failed</td>
                <td><span style="color: #991b1b;">${data.FAILED_COUNT}</span></td>
              </tr>
              <tr>
                <td>Pending / Evaluating</td>
                <td>${data.PENDING_COUNT}</td>
              </tr>
            </table>
          </div>

          ${patchesHtml}
          ${topFailedHtml}

          <p class="highlight">${data.KEY_MESSAGE}</p>
          <p>${data.ACTION_REQUIRED}</p>
          <p>Regards,<br>${data.TEAM_NAME}</p>
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #002d5b; color: #ffffff; padding: 20px 25px; font-family: Arial, sans-serif; font-size: 12px;">
          <tr>
            <td align="left" valign="middle" style="color: #cbd5e1; line-height: 1.6;">
              <strong style="color: #ffffff; font-size: 13px;">Classification: Internal</strong><br>
              This is an automated notification from BigFix Patch Setu.<br>
              For queries or support, contact ${data.CONTACT_INFO}.
            </td>
            <td align="right" valign="bottom" style="color: #94a3b8;">
              &copy; ${new Date().getFullYear()} HCLSoftware
            </td>
          </tr>
        </table>

      </div>
    </div>
  </body>
  </html>
  `;
}

// 🚀 PRE-PATCH TRIGGER MAIL
async function sendTriggerMail(smtp, {
  environment, baselineName, groupName, actionId,
  emailTo, emailFrom, emailCc, emailBcc,
  SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC, csvContent, patchesCsvContent, baselinePatches
}) {
  const transporter = buildTransport(smtp);
  const stageName = environment || "Baseline";
  const subject = `[Triggered] Pre-Patching Notification: ${stageName} - ${baselineName}`;

  const preMetrics = parsePrePatchMetrics(csvContent);
  const currentTime = new Date().toLocaleString();

  const html = buildHtmlContent({
    EMAIL_TITLE: `Patching Triggered: ${stageName}`,
    INTRO_MESSAGE: `A new patching cycle has been successfully triggered for the <b>${stageName}</b> environment. Target servers will now begin evaluating and installing required patches.`,
    ENVIRONMENT: stageName,
    BASELINE: baselineName,
    SCOPE: groupName,
    ACTION_ID: String(actionId),
    TIME_WINDOW: `Initiated: ${currentTime}`,
    STATUS_BADGE: `<span class="badge warning">In Progress</span>`,
    UNIQUE_SYSTEMS: preMetrics.total > 0 ? String(preMetrics.total) : "TBD",
    TOTAL_OPERATIONS: null, 
    PATCHED_COUNT: "-",
    FAILED_COUNT: "-",
    PENDING_COUNT: "Evaluating...",
    BASELINE_PATCHES: baselinePatches, 
    TOP_FAILED_PATCHES: [], 
    KEY_MESSAGE: "Target systems are now entering their designated patching windows.",
    ACTION_REQUIRED: csvContent ? "Attached are CSV files detailing the Targeted Servers and the specific Patches/CVEs included in this baseline." : "No detailed target report is available for this action.",
    TEAM_NAME: "BigFix Patch Setu Automation",
    CONTACT_INFO: "your IT Support Helpdesk",
  });

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const attachments = [];
  if (csvContent) attachments.push({ filename: `${stageName}_Target_Servers_${actionId}.csv`, content: csvContent, contentType: "text/csv; charset=utf-8" });
  if (patchesCsvContent) attachments.push({ filename: `Baseline_Patches_${actionId}.csv`, content: patchesCsvContent, contentType: "text/csv; charset=utf-8" });

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList?.length ? toList.join(", ") : undefined,
    cc: ccList?.length ? ccList.join(", ") : undefined,
    bcc: bccList?.length ? bccList.join(", ") : undefined,
    subject,
    html,
    attachments,
  });
  return info;
}

// 🚀 POST-PATCH COMPLETION MAIL
async function sendPostPatchMail(smtp, {
  environment, baselineName, groupName, actionId, overallStatus, startedAt, endedAt,
  emailTo, emailFrom, emailCc, emailBcc,
  SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC, csvContent, patchesCsvContent, baselinePatches
}) {
  const transporter = buildTransport(smtp);
  const stageName = environment || "Baseline";
  const subject = `[Completed] Post-Patching Report: ${stageName} - ${baselineName}`;

  let badgeHtml = `<span class="badge success">Completed</span>`;
  let displayStatus = overallStatus || "Completed";
  if (displayStatus.toLowerCase().includes("manually") || displayStatus.toLowerCase().includes("console")) {
      badgeHtml = `<span class="badge danger">${escapeHtml(displayStatus)}</span>`;
  } else if (displayStatus.toLowerCase().includes("expired")) {
      displayStatus = "Window Expired"; badgeHtml = `<span class="badge success">Window Expired</span>`;
  } else if (displayStatus.toLowerCase().includes("schedule")) {
      displayStatus = "Completed Successfully"; badgeHtml = `<span class="badge success">Completed Successfully</span>`;
  }

  const timeWindow = (startedAt && endedAt) ? `${startedAt} to ${endedAt}` : "Window Closed / Action Stopped";
  
  const metrics = parsePostPatchMetrics(csvContent);

  const html = buildHtmlContent({
    EMAIL_TITLE: `Patching Concluded: ${stageName}`,
    INTRO_MESSAGE: `The patching cycle for the <b>${stageName}</b> environment has officially concluded. Please review the summary of the deployment below.`,
    ENVIRONMENT: stageName,
    BASELINE: baselineName,
    SCOPE: groupName,
    ACTION_ID: String(actionId),
    TIME_WINDOW: timeWindow,
    STATUS_BADGE: badgeHtml,
    UNIQUE_SYSTEMS: String(metrics.uniqueServers),
    TOTAL_OPERATIONS: String(metrics.totalRows),
    PATCHED_COUNT: String(metrics.success),
    FAILED_COUNT: String(metrics.failed),
    PENDING_COUNT: String(metrics.pending),
    BASELINE_PATCHES: baselinePatches, 
    TOP_FAILED_PATCHES: metrics.topFailedPatches, 
    KEY_MESSAGE: "The designated patching window for this action has been closed and the action is no longer active.",
    ACTION_REQUIRED: csvContent ? "Attached are CSV files detailing the Server Action Results (including error codes) and the specific Patches/CVEs included in this baseline." : "No detailed report was generated for this action.",
    TEAM_NAME: "BigFix Patch Setu Automation",
    CONTACT_INFO: "your IT Support Helpdesk",
  });

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const attachments = [];
  if (csvContent) attachments.push({ filename: `${stageName}_Action_Results_${actionId}.csv`, content: csvContent, contentType: "text/csv; charset=utf-8" });
  if (patchesCsvContent) attachments.push({ filename: `Baseline_Patches_${actionId}.csv`, content: patchesCsvContent, contentType: "text/csv; charset=utf-8" });

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList?.length ? toList.join(", ") : undefined,
    cc: ccList?.length ? ccList.join(", ") : undefined,
    bcc: bccList?.length ? bccList.join(", ") : undefined,
    subject,
    html,
    attachments,
  });
  return info;
}

module.exports = { sendTriggerMail, sendPostPatchMail };