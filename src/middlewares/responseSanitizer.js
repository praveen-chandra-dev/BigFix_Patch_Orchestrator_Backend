
const PRIVATE_IP_REGEX = new RegExp(
  [
    // 10.x.x.x
    String.raw`\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`,
    // 172.16.x.x – 172.31.x.x
    String.raw`\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b`,
    // 192.168.x.x
    String.raw`\b192\.168\.\d{1,3}\.\d{1,3}\b`,
    // 169.254.x.x (link-local)
    String.raw`\b169\.254\.\d{1,3}\.\d{1,3}\b`,
    // 127.x.x.x (loopback)
    String.raw`\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`,
  ].join('|'),
  'g'
);

// Absolute filesystem paths.
//   Windows  : C:\foo\bar or \\server\share\foo
//   POSIX    : /var/foo, /etc/foo, /usr/foo, /opt/foo, /home/foo, /root/...
// We deliberately do NOT match every leading slash (would clobber URL
// paths like "/api/things"). We match likely OS-installation paths only.
const ABS_PATH_REGEX = new RegExp(
  [
    // Windows drive paths     C:\Program Files\PatchSetu\...
    String.raw`\b[A-Za-z]:\\(?:[^\\\/\:\*\?\"<>\|\r\n]+\\?)+`,
    // Windows UNC paths       \\server\share\...
    String.raw`\\\\[^\\\/\:\*\?\"<>\|\r\n]+\\[^\\\/\:\*\?\"<>\|\r\n]+(?:\\[^\\\/\:\*\?\"<>\|\r\n]+)*`,
    // POSIX system roots that almost never appear in URL paths
    String.raw`(?:^|\s|"|'|\()(\/(?:var|etc|usr|opt|home|root|tmp|srv|mnt|proc|sys)(?:\/[^\s"'\)<>]+)+)`,
  ].join('|'),
  'g'
);

// Simple RFC-ish email regex. Conservative: requires a dot in the domain.
const EMAIL_REGEX = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

/**
 * Returns a string with private IPs, OS-style absolute paths and emails
 * redacted. Leaves URL-style paths ("/api/things") and public-looking
 * IPs ("8.8.8.8") alone.
 */
function redactString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s
    .replace(PRIVATE_IP_REGEX, '[redacted-ip]')
    .replace(EMAIL_REGEX, '[redacted-email]')
    // Apply path regex last so URL-path-looking fragments inside emails
    // (which won't match because we already replaced the email) aren't
    // double-matched.
    .replace(ABS_PATH_REGEX, (match, captured) => {
      // The POSIX alternative has a capture group for the path itself —
      // preserve the leading whitespace/quote/paren that anchored the
      // match.
      if (captured) {
        const lead = match.slice(0, match.length - captured.length);
        return lead + '[redacted-path]';
      }
      return '[redacted-path]';
    });
}

/**
 * Walk an arbitrary JSON-serialisable value and redact strings in place,
 * returning a NEW value. Does not mutate the input.
 */
function redactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Don't redact the KEY itself (would break clients expecting fixed
      // property names); only the values.
      out[k] = redactValue(v);
    }
    return out;
  }
  // numbers, booleans, etc. pass through
  return value;
}

function shouldBypass(req, bypassPaths) {
  const url = req.path || req.url || '';
  for (const p of bypassPaths) {
    if (p instanceof RegExp) {
      if (p.test(url)) return true;
    } else if (typeof p === 'string') {
      if (url === p || url.startsWith(p + '/')) return true;
    }
  }
  return false;
}

/**
 * responseSanitizer({ bypassPaths: [/regex/, "/string/path"] }) -> middleware
 */
function responseSanitizer(opts = {}) {
  const bypassPaths = Array.isArray(opts.bypassPaths) ? opts.bypassPaths : [];

  return function sanitizerMiddleware(req, res, next) {
    if (shouldBypass(req, bypassPaths)) {
      return next();
    }

    // Wrap res.json() — used by virtually every route in this app.
    const origJson = res.json.bind(res);
    res.json = function patchedJson(payload) {
      try {
        const sanitized = redactValue(payload);
        return origJson(sanitized);
      } catch (e) {
        // If sanitization itself fails, log and pass through unmodified.
        // The original error path stays intact.
        console.error('[responseSanitizer] redaction error:', e.message);
        return origJson(payload);
      }
    };

    // Wrap res.send() for the small number of routes that send strings/
    // buffers directly. We only sanitize string payloads — binary bodies
    // (PDFs, CSVs sent as Buffer) pass through untouched.
    const origSend = res.send.bind(res);
    res.send = function patchedSend(payload) {
      try {
        if (typeof payload === 'string') {
          // Don't touch HTML — the index.html rewriter handles that
          // separately. If the content-type is HTML and we mangle paths
          // inside it, the SPA might break.
          const ct = res.get('Content-Type') || '';
          if (ct.includes('text/html')) return origSend(payload);
          return origSend(redactString(payload));
        }
      } catch (e) {
        console.error('[responseSanitizer] send redaction error:', e.message);
      }
      return origSend(payload);
    };

    next();
  };
}

module.exports = { responseSanitizer, redactString, redactValue };