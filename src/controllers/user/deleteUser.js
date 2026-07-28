const { sql, getPool } = require('../../db/mssql');

async function deleteUser(req, res) {
    try {
        const { id } = req.params;
        const { currentUserId } = req.body;
        if ([9002, 9003, 9004].includes(Number(id))) return res.status(403).json({ ok: false, error: 'forbidden' });
        if (Number(id) === Number(currentUserId)) return res.status(403).json({ ok: false, error: 'cannot_delete_self' });
        
        const pool = await getPool();
        await pool.request().input('UserID', sql.Int, id).query('DELETE FROM dbo.USERS WHERE UserID = @UserID');
        res.json({ ok: true, deleted: true });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
}

module.exports = deleteUser;