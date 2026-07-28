const restartController = require('./restart.controller');
const serviceRestartController = require('./serviceRestart.controller');
const triggerActionController = require('./triggerAction.controller');

module.exports = {
    restartSingle: restartController.restartSingle,
    restartBulk: restartController.restartBulk,
    serviceRestart: serviceRestartController.serviceRestart,
    triggerAction: triggerActionController.triggerAction
};