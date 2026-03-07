const express = require("express");
const { getPatches } = require("../services/prism");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const patches = await getPatches();
    res.json(patches);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch patches" });
  }
});

module.exports = router;