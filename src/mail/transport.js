// src/mail/transport.js
const nodemailer = require("nodemailer");
const { splitEmails, escapeHtml } = require("../utils/http");

function toBool(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on"; //
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
  const tlsRejectUnauth =
    typeof SMTP_TLS_REJECT_UNAUTH !== "undefined"
      ? toBool(SMTP_TLS_REJECT_UNAUTH)
      : !allowSelfSigned;

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

/**
 * Email Template
 */
function createEmailTemplate({ title, subtitle, details = [], csvAttached = false, statusColor = "#0078D4" }) {
  const styles = {
    body: "font-family: 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background-color: #f8f9fa;",
    container: "width: 90%; max-width: 680px; margin: 20px auto; background-color: #ffffff; border: 1px solid #dee2e6; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);",
    header: `background-color: ${statusColor}; color: #ffffff; padding: 24px 30px;`,
    headerTitle: "margin: 0; font-size: 24px; font-weight: 600;",
    headerSubtitle: "margin: 4px 0 0; font-size: 16px; opacity: 0.9;",
    content: "padding: 30px;",
    table: "width: 100%; border-collapse: collapse;",
    tdKey: "padding: 12px 0; font-size: 14px; color: #6c757d; font-weight: 600; border-bottom: 1px solid #e9ecef; width: 35%;",
    tdValue: "padding: 12px 0; font-size: 14px; color: #212529; font-weight: 400; border-bottom: 1px solid #e9ecef;",
    attachmentNote: "font-size: 14px; color: #495057; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e9ecef;",
    footer: "padding: 30px; text-align: center; font-size: 12px; color: #adb5bd; background-color: #f1f3f5;",
  };

  const detailsHtml = details.map(d => `
    <tr>
      <td style="${styles.tdKey}">${escapeHtml(d.key)}</td>
      <td style="${styles.tdValue}">${escapeHtml(d.value)}</td>
    </tr>
  `).join("");

  const csvHtml = csvAttached
    ? `<p style="${styles.attachmentNote}">A detailed CSV report is attached to this email.</p>`
    : `<p style="${styles.attachmentNote}">No detailed report was attached.</p>`;

  // Subtitle 
  const subtitleHtml = subtitle
    ? `<p style="${styles.headerSubtitle}">${escapeHtml(subtitle)}</p>`
    : "";

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="${styles.body}">
    <div style="${styles.container}">
      <div style="${styles.header}">
        <h1 style="${styles.headerTitle}">${escapeHtml(title)}</h1>
        ${subtitleHtml}
      </div>
      <div style="${styles.content}">
        <table style="${styles.table}" cellpadding="0" cellspacing="0">
          <tbody>
            ${detailsHtml}
          </tbody>
        </table>
        ${csvHtml}
      </div>
      <div style="${styles.footer}">
        BigFix Patch Setu &copy; ${new Date().getFullYear()}
      </div>
    </div>
  </body>
  </html>
  `;
}

async function sendTriggerMail(smtp, {
  environment, baselineName, baselineSite, baselineFixletId,
  groupName, groupId, groupSite, groupType,
  actionId, endOffset,
  emailTo, emailFrom, emailCc, emailBcc,
  SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC,
  csvContent,
}) {
  const transporter = buildTransport(smtp);
  const stageName = environment || "Baseline";
  
  // Subject line update
  const subject = `Pre-Patching Triggered For Baseline ${baselineName}`;

  const details = [
    { key: "Stage", value: stageName },
    { key: "Action ID", value: actionId || "Unknown" },
    { key: "Baseline", value: baselineName },
    { key: "Target Group", value: groupName },

  ];

  const html = createEmailTemplate({
    title: `${stageName} Patching Triggered`,
    subtitle: "", 
    details: details,
    csvAttached: !!csvContent,
    statusColor: "#0078D4", // Blue for "Triggered"
  });
  
  const text = details.map(d => `${d.key}: ${d.value}`).join("\n");

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const attachments = [];
  if (csvContent) {
    attachments.push({
      filename: `${stageName}_Target_Server_List.csv`,
      content: csvContent,
      contentType: "text/csv; charset=utf-8",
    });
  }

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList?.length ? toList.join(", ") : undefined,
    cc: ccList?.length ? ccList.join(", ") : undefined,
    bcc: bccList?.length ? bccList.join(", ") : undefined,
    subject,
    text,
    html,
    attachments,
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, envelope: info.envelope, response: info.response };
}

/**
 * UPDATED: Post-patch mail (receives full results CSV)
 */
async function sendPostPatchMail(smtp, {
  environment, baselineName, baselineSite, baselineFixletId,
  groupName, groupId, groupSite, groupType,
  actionId, overallStatus, startedAt, endedAt,
  emailTo, emailFrom, emailCc, emailBcc,
  SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC,
  csvContent, // This will now be the full results CSV
}) {
  const transporter = buildTransport(smtp);
  const stageName = environment || "Baseline";
  const subject = `Post-Patching Status ${stageName} - ${baselineName}`;


  const details = [
    { key: "Stage", value: stageName },
    { key: "Action ID", value: actionId || "Unknown" },
    { key: "Baseline", value: baselineName },
    { key: "Target Group", value: groupName }, 
    { key: "Window Start", value: startedAt || "N/A" },
    { key: "Window End", value: endedAt || "N/A" },

  ];

  const html = createEmailTemplate({
    title: `${stageName} Post Patching Completed`,
    subtitle: "", 
    details: details,
    csvAttached: !!csvContent,
    statusColor: (overallStatus || "").toLowerCase() === "expired" ? "#107C10" : "#D83B01", // Green for "Expired", Red for other
  });

  const text = details.map(d => `${d.key}: ${d.value}`).join("\n");

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const attachments = [];
  if (csvContent) {
    attachments.push({
      filename: `${stageName}_Action_Results.csv`, // Filename changed
      content: csvContent,
      contentType: "text/csv; charset=utf-8",
    });
  }

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList?.length ? toList.join(", ") : undefined,
    cc: ccList?.length ? ccList.join(", ") : undefined,
    bcc: bccList?.length ? bccList.join(", ") : undefined,
    subject,
    text,
    html,
    attachments,
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, envelope: info.envelope, response: info.response };
}

module.exports = { sendTriggerMail, sendPostPatchMail };