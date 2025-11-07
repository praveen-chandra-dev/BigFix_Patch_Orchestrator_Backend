// src/mail/transport.js
const { splitEmails, escapeHtml } = require("../utils/http");

function buildTransport(smtp) {
  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD,
    SMTP_ALLOW_SELF_SIGNED, nodemailer
  } = smtp;

  const secure = String(SMTP_SECURE).toLowerCase() === "true";
  const allowSelfSigned = String(SMTP_ALLOW_SELF_SIGNED).toLowerCase() === "true";

  const transportOpts = {
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure,
    tls: { rejectUnauthorized: !allowSelfSigned },
  };

  // use correct password key
  if (SMTP_USER || SMTP_PASSWORD) {
    transportOpts.auth = { user: SMTP_USER, pass: SMTP_PASSWORD };
  }

  return nodemailer.createTransport(transportOpts);
}

async function sendSandboxMail(smtp, {
  baselineName, baselineSite, baselineFixletId,
  groupName, groupId, groupSite, groupType,
  customRelevance, actionXml, actionId,
  emailTo, emailFrom, emailCc, emailBcc,
  SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC,
}) {
  const transporter = buildTransport(smtp);

  const subject = `Sandbox baseline triggered: ${baselineName} → ${groupName}`;
  const lines = [
    `Sandbox patching has been triggered.`,
    ``,
    `Baseline : ${baselineName}`,
    `Site     : ${baselineSite}`,
    `FixletID : ${baselineFixletId}`,
    ``,
    `Group    : ${groupName}`,
    `Group ID : ${groupId}`,
    `Group Site: ${groupSite}`,
    `Group Type: ${groupType}`,
    ``,
    `Action ID: ${actionId || "Unknown"}`,
    ``,
    `Custom Relevance:`,
    `${customRelevance}`
  ];
  const text = lines.join("\n");
  const html =
    `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#111">` +
    `<h3>Sandbox patching triggered</h3>` +
    `<pre style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px">${escapeHtml(text)}</pre>` +
    `</div>`;

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList && toList.length ? toList.join(", ") : undefined,
    cc: ccList && ccList.length ? ccList.join(", ") : undefined,
    bcc: bccList && bccList.length ? bccList.join(", ") : undefined,
    subject, text, html,
  });

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, envelope: info.envelope, response: info.response };
}

module.exports = { sendSandboxMail };
