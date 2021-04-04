'use strict';
var pm2 = require('pm2');
var pmx = require('pmx');
var request = require('request');
var stripAnsi = require('strip-ansi');

// Get the configuration from PM2
var conf = pmx.initModule();

// initialize buffer and queue_max opts
// buffer seconds can be between 1 and 5
conf.buffer_seconds = (conf.buffer_seconds > 0 && conf.buffer_seconds < 5) ? conf.buffer_seconds : 1;

// queue max can be between 10 and 100
conf.queue_max = (conf.queue_max > 10 && conf.queue_max <= 100) ? conf.queue_max : 100;

// create the message queue
var messages = {
  "crafty-bot": [],
  "crafty-bot-beta": [],
  "crafty-api": [],
  "crafty-api-beta": [],
  scheduler: [],
  "verification-server": [],
  "webhook-server": [],
}

// create the suppressed object for sending suppression messages
var suppressed = {
  isSuppressed: false,
  date: new Date().getTime()
};

function getWebhook(name) {
  switch (name) {
    case "crafty-bot":
      return conf.webhook_crafty_bot
    case "crafty-bot-beta":
      return conf.webhook_crafty_bot_beta
    case "crafty-api":
      return conf.webhook_api
    case "crafty-api-beta":
      return conf.webhook_api_beta
    case "scheduler":
      return conf.webhook_scheduler
    case "verification_server":
      return conf.webhook_verification_server
    case "webhook_server":
      return conf.webhook_webhook_server
    default:
      return conf.discord_url
  }
}

// Function to send event to Discord's Incoming Webhook
function sendToDiscord(message) {
  var description = message.description;

  // If a Discord URL is not set, we do not want to continue and nofify the user that it needs to be set
  if (!conf.discord_url) {
    return console.error("There is no Discord URL set, please set the Discord URL: 'pm2 set pm2-discord:discord_url https://[discord_url]'");
  }

  // The JSON payload to send to the Webhook
  var payload = {
    "content": `\`\`\`${description}\`\`\``
  };

  // Options for the post request
  var options = {
    method: 'post',
    body: payload,
    json: true,
    url: getWebhook(message.name)
  };

  // Finally, make the post request to the Discord Incoming Webhook
  request(options, function (err, res, body) {
    if (err) {
      return console.error(err);
    }
    /* A successful POST to Discord's webhook responds with a 204 NO CONTENT */
    if (res.statusCode !== 204) {
      console.error("Error occured during the request to the Discord webhook");
    }
  });
}

// Function to get the next buffer of messages (buffer length = 1s)
function bufferMessage(process) {
  var nextMessage = messages[process].shift();

  if (!conf.buffer) {
    return nextMessage;
  }

  nextMessage.buffer = [nextMessage.description];

  // continue shifting elements off the queue while they are the same event and 
  // timestamp so they can be buffered together into a single request
  while (messages[process].length &&
    (messages[process][0].timestamp >= nextMessage.timestamp &&
      messages[process][0].timestamp < (nextMessage.timestamp + conf.buffer_seconds)) &&
    messages[process][0].event === nextMessage.event) {

    // append description to our buffer and shift the message off the queue and discard it
    nextMessage.buffer.push(messages[process][0].description);
    messages[process].shift();
  }

  // join the buffer with newlines
  nextMessage.description = nextMessage.buffer.join("\n");

  // delete the buffer from memory
  delete nextMessage.buffer;

  return nextMessage;
}


function processQueue() {
  for (const process in messages) {
    if (messages[process].length > 0) sendToDiscord(bufferMessage(process));
    if (messages[process].length > conf.queue_max) {
      if (!suppressed.isSuppressed) {
        suppressed.isSuppressed = true;
        suppressed.date = new Date().getTime();
        sendToDiscord({
          name: 'pm2-discord-crafty',
          event: 'suppressed',
          description: 'Messages are being suppressed due to rate limiting.'
        });
      }
      messages[process].splice(conf.queue_max, messages[process].length);
    }
  }

  // If the suppression message has been sent over 1 minute ago, we need to reset it back to false
  if (suppressed.isSuppressed && suppressed.date < (new Date().getTime() - 60000)) {
    suppressed.isSuppressed = false;
  }

  setTimeout(function () {
    processQueue();
  }, 10000);
}

function createMessage(data, eventName, altDescription) {
  // we don't want to output pm2-discord's logs
  if (data.process.name === 'pm2-discord-crafty') {
    return;
  }

  var msg = altDescription || data.data;
  if (typeof msg === "object") {
    msg = JSON.stringify(msg);
  }

  messages[data.process.name].push({
    name: data.process.name,
    event: eventName,
    description: stripAnsi(msg),
    timestamp: Math.floor(Date.now() / 1000),
  });
}

// Start listening on the PM2 BUS
pm2.launchBus(function (err, bus) {

  // Listen for process logs
  if (conf.log) {
    bus.on('log:out', function (data) {
      createMessage(data, 'log');
    });
  }

  // Listen for process errors
  if (conf.error) {
    bus.on('log:err', function (data) {
      createMessage(data, 'error');
    });
  }

  // Listen for PM2 kill
  if (conf.kill) {
    bus.on('pm2:kill', function (data) {
      messages.push({
        name: 'PM2',
        event: 'kill',
        description: data.msg,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for process exceptions
  if (conf.exception) {
    bus.on('process:exception', function (data) {
      createMessage(data, 'exception');
    });
  }

  // Listen for PM2 events
  bus.on('process:event', function (data) {
    if (!conf[data.event]) {
      return;
    }
    var msg = 'The following event has occured on the PM2 process ' + data.process.name + ': ' + data.event;
    createMessage(data, data.event, msg);
  });

  // Start the message processing
  processQueue();

});