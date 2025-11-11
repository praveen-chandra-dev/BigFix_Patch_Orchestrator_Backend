// main.js
require("dotenv").config();
const { buildApp } = require("./src/app");

const { logger } = require("./src/services/logger");
// --- END NEW ---

const PORT = Number(process.env.PORT || 5174);
const app = buildApp();


app.listen(PORT, () => {
  // --- UPDATED ---
  // Use the new logger for startup. This will go to console and file.
  logger.info(`API listening on http://localhost:${PORT}`);
  // --- END UPDATED ---
});