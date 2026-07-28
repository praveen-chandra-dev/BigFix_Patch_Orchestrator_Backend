const { sql } = require('../db/mssql');
const { logger } = require('../services/logger');

const getPolicies = async (req, res) => {
    try {
        const request = new sql.Request();
        const result = await request.query(`
            SELECT 
                ID, PolicyName, Description, Modified, CreatedBy, Site, 
                PatchTypes, Devices, Groups, OS, Patches, CustomContent, 
                PatchUpdates, NextRefresh, Status 
            FROM dbo.PatchPolicies 
            ORDER BY Modified DESC
        `);
        res.status(200).json({ success: true, data: result.recordset });
    } catch (error) {
        logger.error(`[PatchPolicy] Error fetching policies: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to fetch policies' });
    }
};

const createPolicy = async (req, res) => {
    const { policyName, description, site, patchTypes, groups, os, customContent, status } = req.body;
    const createdBy = req.user?.username || 'Admin';

    try {
        const request = new sql.Request();
        request.input('PolicyName', sql.NVarChar, policyName);
        request.input('Description', sql.NVarChar, description || '');
        request.input('CreatedBy', sql.NVarChar, createdBy);
        request.input('Site', sql.NVarChar, site || 'Master Action Site');
        request.input('PatchTypes', sql.NVarChar, patchTypes || 'All');
        request.input('Groups', sql.NVarChar, groups || 'All Computers');
        request.input('OS', sql.NVarChar, os || 'Windows');
        request.input('CustomContent', sql.NVarChar, customContent || 'None');
        request.input('Status', sql.NVarChar, status || 'Suspended');

        await request.query(`
            INSERT INTO dbo.PatchPolicies 
            (PolicyName, Description, CreatedBy, Site, PatchTypes, Groups, OS, CustomContent, Status, NextRefresh, PatchUpdates)
            VALUES 
            (@PolicyName, @Description, @CreatedBy, @Site, @PatchTypes, @Groups, @OS, @CustomContent, @Status, 'Pending', 'Up to date')
        `);
        
        res.status(201).json({ success: true, message: 'Policy Created Successfully' });
    } catch (error) {
        logger.error(`[PatchPolicy] Error creating policy: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to create policy' });
    }
};

const updatePolicy = async (req, res) => {
    const { id } = req.params;
    const { policyName, description, site, patchTypes, groups, os, customContent, status } = req.body;
    
    try {
        const request = new sql.Request();
        request.input('ID', sql.Int, id);
        request.input('PolicyName', sql.NVarChar, policyName);
        request.input('Description', sql.NVarChar, description || '');
        request.input('Site', sql.NVarChar, site || 'Master Action Site');
        request.input('PatchTypes', sql.NVarChar, patchTypes || 'All');
        request.input('Groups', sql.NVarChar, groups || 'All Computers');
        request.input('OS', sql.NVarChar, os || 'Windows');
        request.input('CustomContent', sql.NVarChar, customContent || 'None');
        request.input('Status', sql.NVarChar, status || 'Suspended');

        await request.query(`
            UPDATE dbo.PatchPolicies 
            SET PolicyName = @PolicyName, Description = @Description, Site = @Site, 
                PatchTypes = @PatchTypes, Groups = @Groups, OS = @OS, 
                CustomContent = @CustomContent, Status = @Status, Modified = SYSUTCDATETIME()
            WHERE ID = @ID
        `);
        
        res.status(200).json({ success: true, message: 'Policy Updated Successfully' });
    } catch (error) {
        logger.error(`[PatchPolicy] Error updating policy: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to update policy' });
    }
};

const deletePolicy = async (req, res) => {
    try {
        const { id } = req.params;
        const request = new sql.Request();
        await request.input('ID', sql.Int, id).query(`DELETE FROM dbo.PatchPolicies WHERE ID = @ID`);
        res.status(200).json({ success: true, message: 'Policy deleted successfully' });
    } catch (error) {
        logger.error(`[PatchPolicy] Error deleting policy: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to delete policy' });
    }
};

module.exports = { getPolicies, createPolicy, updatePolicy, deletePolicy };