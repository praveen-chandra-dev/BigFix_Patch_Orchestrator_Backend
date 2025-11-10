// main.js
require("dotenv").config();
const { buildApp } = require("./src/app");

const PORT = Number(process.env.PORT || 5174);
const app = buildApp();


app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});


