// src/bigfix/client.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");

function makeBigFix() {
  return {
    joinUrl,
    axios,
  };
}//

module.exports = { makeBigFix };
