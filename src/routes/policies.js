const express = require('express');
const router = express.Router();
const { getPolicies, createPolicy, updatePolicy, deletePolicy } = require('../controllers/policies.controller');

router.get('/api/policies', getPolicies);
router.post('/api/policies', createPolicy);
router.put('/api/policies/:id', updatePolicy);
router.delete('/api/policies/:id', deletePolicy);

// Dynamic loading function for Express app
function attachPoliciesRoutes(app) {
    app.use(router);
}

module.exports = { attachPoliciesRoutes };