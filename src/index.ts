const pm2 = require('pm2');
const pmx = require('pmx');
import sendToDiscord from './send-to-discord';
import MessageQueue from './message-queue';
import { LogMessage, Process, DiscordMessage, SomeConfig } from './types/index';
import { SubEmitterSocket } from 'axon';

// Get the configuration from PM2
const moduleConfig = pmx.initModule();

const msgRouter = {
  /**
   * Keys are slackUrls, values are instances of MessageQueue
   *
   * @typedef {Object.<string, MessageQueue>}
   */
  messageQueues: {},


  /**
   * Add the message to appropriate message queue (each Slack URL has own independent message enqueing).
   *
   * @param {Message} message
   */
  addMessage: function(message: DiscordMessage) {
      const processName = message.name;
      const slackUrl = moduleConfig['slack_url-' + processName] || moduleConfig['slack_url'];

      if (!slackUrl) {
          return;
          // No Slack URL defined for this process and no global Slack URL exists.
      }

      if (!this.messageQueues[slackUrl]) {
          // Init new messageQueue to different Slack URL.

          // Resolve configuration parameters.
          const configProperties = ['username', 'servername', 'buffer', 'slack_url', 'buffer_seconds', 'buffer_max_seconds', 'queue_max'];
          const config: SomeConfig = {};
          configProperties.forEach((configPropertyName: string) => {
              // Use process based custom configuration values if exist, else use the global configuration values.
              config[configPropertyName] = moduleConfig[configPropertyName + '-' + processName] || moduleConfig[configPropertyName];
          });

          this.messageQueues[slackUrl] = new MessageQueue(config);
      }

      this.messageQueues[slackUrl].addMessageToQueue(message);

  }
};

/**
 * New PM2 is storing log messages with date in format "YYYY-MM-DD hh:mm:ss +-zz:zz"
 * Parses this date from begin of message
 */
function parseIncommingLog(logMessage: string): LogMessage {
  let description = null;
  let timestamp = null;

  if (typeof logMessage === "string") {
    // Parse date on begin (if exists)
    const dateRegex = /([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})? [+\-]?[0-9]{1,2}:[0-9]{2}(\.[0-9]{3})?)[:\-\s]+/;
    const parsedDescription = dateRegex.exec(logMessage);
    // Note: The `parsedDescription[0]` is datetime with separator(s) on the end.
    //       The `parsedDescription[1]` is datetime only (without separators).
    //       The `parsedDescription[2]` are ".microseconds"
    if (parsedDescription && parsedDescription.length >= 2) {
      // Use timestamp from message
      timestamp = Math.floor(Date.parse(parsedDescription[1]) / 1000);
      // Use message without date
      description = logMessage.replace(parsedDescription[0], "");
    } else {
      // Use whole original message
      description = logMessage;
    }
  }

  return {
    description: description,
    timestamp: timestamp
  }
}

/**
 * Get pm2 app display name.
 * If the app is running in cluster mode, id will append [pm_id] as the suffix.
 */
function parseProcessName(process: Process) {
  return process.name + (
    process.exec_mode === 'cluster_mode' &&
      process.instances > 1 ? `[${process.pm_id}]` : ''
  );
}


// Start listening on the PM2 BUS
pm2.launchBus(function (err: Error, bus: SubEmitterSocket) {

  // Listen for process logs
  if (moduleConfig.log) {
    bus.on('log:out', function (data) {
      if (data.process.name === 'pm2-slack') { return; } // Ignore messages of own module.

      const parsedLog = parseIncommingLog(data.data);
      msgRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'log',
        description: parsedLog.description,
        timestamp: parsedLog.timestamp,
      });
    });
  }

  // Listen for process errors
  if (moduleConfig.error) {
    bus.on('log:err', function (data) {
      if (data.process.name === 'pm2-slack') { return; } // Ignore messages of own module.

      const parsedLog = parseIncommingLog(data.data);
      msgRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'error',
        description: parsedLog.description,
        timestamp: parsedLog.timestamp,
      });
    });
  }

  // Listen for PM2 kill
  if (moduleConfig.kill) {
    bus.on('pm2:kill', function (data) {
      msgRouter.addMessage({
        name: 'PM2',
        event: 'kill',
        description: data.msg,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for process exceptions
  if (moduleConfig.exception) {
    bus.on('process:exception', function (data) {
      if (data.process.name === 'pm2-slack') { return; } // Ignore messages of own module.

      // If it is instance of Error, use it. If type is unknown, stringify it.
      const description = (data.data && data.data.message) ? (data.data.code || '') + data.data.message : JSON.stringify(data.data);
      msgRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'exception',
        description: description,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for PM2 events
  bus.on('process:event', function (data) {
    if (!moduleConfig[data.event]) { return; } // This event type is disabled by configuration.
    if (data.process.name === 'pm2-slack') { return; } // Ignore messages of own module.

    let description = null;
    switch (data.event) {
      case 'start':
      case 'stop':
      case 'restart':
        description = null;
        break;

      case 'restart overlimit':
        description = 'Process has been stopped. Check and fix the issue.';
        break;

    }
    msgRouter.addMessage({
      name: parseProcessName(data.process),
      event: data.event,
      description: description,
      timestamp: Math.floor(Date.now() / 1000),
    });
  });
});