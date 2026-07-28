const pilotController = require('./pilot.controller');
const productionController = require('./production.controller');

module.exports = {
    triggerPilot: pilotController.triggerPilot,
    triggerPilotForce: pilotController.triggerPilotForce,
    triggerProduction: productionController.triggerProduction,
    triggerProductionForce: productionController.triggerProductionForce
};