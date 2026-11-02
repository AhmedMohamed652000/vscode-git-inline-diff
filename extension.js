'use strict';

const { Controller } = require('./src/controller');
const { registerProviders } = require('./src/providers');
const { registerCommands } = require('./src/commands');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  const controller = new Controller(context);
  context.subscriptions.push(controller, ...registerProviders(controller), ...registerCommands(controller));
  return { controller };
}

function deactivate() {}

module.exports = { activate, deactivate };
