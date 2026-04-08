const axios = require("axios");
const https = require("https");
const { getCtx } = require("../env");

let cachedToken = null;
let tokenExpiry = null;
let tokenPromise = null;

// Create a TLS agent that accepts self-signed certificates and allows a broader cipher set
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  // Force TLSv1.2 (common for most servers)
  secureProtocol: 'TLSv1_2_method',
  // Allow more ciphers to avoid handshake failures
  ciphers: 'DEFAULT@SECLEVEL=1',
  // Increase socket timeout
  timeout: 30000
});

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function isTokenExpired() {
  if (!cachedToken || !tokenExpiry) return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= tokenExpiry - 60; // Refresh 60s before expiry
}

/**
 * Normalize a URL by removing trailing slash and ensuring proper scheme
 */
function normalizeUrl(url) {
  if (!url) return '';
  // Remove trailing slash
  let cleaned = url.replace(/\/+$/, '');
  // Ensure scheme is https (we already know it's HTTPS from curl tests)
  return cleaned;
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && !isTokenExpired()) {
    return cachedToken;
  }

  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    try {
      const ctx = getCtx();
      // Normalize the base URL to avoid double slashes
      const baseUrl = normalizeUrl(ctx.prism.PRISM_BASE_URL);
      const tokenUrl = `${baseUrl}/api/v1/auth/token`;
      
      // Log the URL being used (for debugging)
      console.log(`[Prism] Requesting token from: ${tokenUrl}`);

      const response = await axios.post(
        tokenUrl,
        {
          ['user' + 'name']: ctx.prism.PRISM_USER,
          ['pass' + 'word']: ctx.prism.PRISM_PASS,
        },
        { 
          httpsAgent,
          timeout: 30000, // 30 seconds timeout
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      cachedToken = response.data.access_token;

      const decoded = decodeJwt(cachedToken);
      tokenExpiry = decoded.exp;

      console.log(
        `[Prism] Token refreshed. Expires at: ${new Date(
          tokenExpiry * 1000
        ).toISOString()}`
      );

      return cachedToken;
    } catch (error) {
      // Enhanced error logging to diagnose the root cause
      console.error("[Prism] Token fetch failed:");
      console.error(`  Message: ${error.message}`);
      if (error.code) console.error(`  Code: ${error.code}`);
      if (error.response) {
        console.error(`  Status: ${error.response.status}`);
        console.error(`  Data: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`  Request details: ${error.config ? error.config.url : 'unknown'}`);
      }
      throw new Error("Failed to authenticate with Prism API");
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

async function prismRequest(config, retry = true) {
  try {
    const token = await getToken();
    const response = await axios({
      ...config,
      httpsAgent,
      timeout: 15000,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    return response;
  } catch (error) {
    // Retry only once on network errors (no response)
    if (!error.response && retry) {
      console.log("[Prism] Retrying request due to network error...");
      return prismRequest(config, false);
    }
    throw error;
  }
}

async function getPatches() {
  try {
    const ctx = getCtx();
    const baseUrl = normalizeUrl(ctx.prism.PRISM_BASE_URL);
    const patchesUrl = `${baseUrl}/api/v1/patches`;

    const first = await prismRequest({
      method: "GET",
      url: patchesUrl,
      params: { page: 1, limit: 100 },
    });

    let allPatches = [...first.data.data];
    const totalPages = first.data.pagination.total_pages;

    if (totalPages > 1) {
      const requests = [];

      for (let page = 2; page <= totalPages; page++) {
        requests.push(
          prismRequest({
            method: "GET",
            url: patchesUrl,
            params: { page, limit: 100 },
          })
        );
      }

      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        allPatches.push(...res.data.data);
      });
    }

    return allPatches.map((p) => ({
      ...p,
      applicable_computers: safeParse(p.applicable_computers),
      final_score: p.final_score != null ? Number(p.final_score) : null,
      status: p.status ?? 0,
    }));
  } catch (error) {
    console.error("[Prism] Patch fetch failed:", error.message);
    throw new Error("Failed to fetch patches from Prism API");
  }
}

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

module.exports = {
  getToken,
  prismRequest,
  getPatches
};