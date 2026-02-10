// bigfix-backend/src/routes/calendar.js
const express = require('express');
const router = express.Router();
const { sql, getPool } = require('../db/mssql');

// GET: Retrieve calendar events (Role-Based Filtering)
router.get('/api/calendar', async (req, res) => {
  try {
    const { role } = req.query; // Get role from query params
    const pool = await getPool();
    
    let query = 'SELECT * FROM dbo.PatchSchedule';
    const request = pool.request();

    // Apply Filters based on Role
    if (role) {
      const r = role.toLowerCase();
      if (r === 'windows') {
        query += " WHERE OperatingSystem = 'Windows'";
      } else if (r === 'linux') {
        query += " WHERE OperatingSystem = 'Linux'";
      }
      // If Admin, no WHERE clause -> sees all
    }

    query += ' ORDER BY Year, MonthIndex, Day';

    const result = await request.query(query);
    
    // Map DB columns to frontend keys
    const events = result.recordset.map(row => ({
      server: row.ServerName,
      day: row.Day,
      monthIndex: row.MonthIndex,
      year: row.Year,
      time: row.Time,
      os: row.OperatingSystem
    }));
    
    res.json({ ok: true, events });
  } catch (error) {
    console.error("Calendar GET Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST: Upload new calendar
router.post('/api/calendar', async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ ok: false, error: "Invalid data format" });
    }

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    
    await transaction.begin();
    try {
      // 1. Clear existing schedule
      const deleteReq = new sql.Request(transaction);
      await deleteReq.query('DELETE FROM dbo.PatchSchedule');

      // 2. Insert new events
      for (const ev of events) {
        const insertReq = new sql.Request(transaction);
        
        await insertReq
          .input('ServerName', sql.NVarChar(255), ev.server)
          .input('Day', sql.Int, ev.day)
          .input('MonthIndex', sql.Int, ev.monthIndex)
          .input('Year', sql.Int, ev.year)
          .input('Time', sql.NVarChar(50), ev.time)
          .input('OS', sql.NVarChar(50), ev.os || 'Windows')
          .query(`INSERT INTO dbo.PatchSchedule (ServerName, Day, MonthIndex, Year, Time, OperatingSystem) VALUES (@ServerName, @Day, @MonthIndex, @Year, @Time, @OS)`);
      }

      await transaction.commit();
      res.json({ ok: true, message: "Calendar updated successfully" });

    } catch (err) {
      await transaction.rollback();
      throw err;
    }

  } catch (error) {
    console.error("Calendar POST Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;