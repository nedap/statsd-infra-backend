/* jshint node:true, laxcomma:true */

/*
 * Flush stats to New Relic Infrastucture Agent.
 *
 * To enable this backend, include 'newrelic-infra' in the backends
 * configuration array:
 *
 *   backends: ['newrelic-infra']
 *
 * This backend supports the following config options in 'newrelic' key:
 *
 *   port: Port where Infrastructure Agent is listening. Defaults to '8001'.
 *   rules: A list of rules to convert StatsD metrics and compose New Relic
 *          Infrastructure payloads.
 *
 */

if (!Object.assign) {
  Object.defineProperty(Object, 'assign', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(target) {
      'use strict';
      if (target === undefined || target === null) {
        throw new TypeError('Cannot convert first argument to object');
      }

      var to = Object(target);
      for (var i = 1; i < arguments.length; i++) {
        var nextSource = arguments[i];
        if (nextSource === undefined || nextSource === null) {
          continue;
        }
        nextSource = Object(nextSource);

        var keysArray = Object.keys(Object(nextSource));
        for (var nextIndex = 0, len = keysArray.length; nextIndex < len; nextIndex++) {
          var nextKey = keysArray[nextIndex];
          var desc = Object.getOwnPropertyDescriptor(nextSource, nextKey);
          if (desc !== undefined && desc.enumerable) {
            to[nextKey] = nextSource[nextKey];
          }
        }
      }
      return to;
    }
  });
}

var http = require('http');

var globalLogger;
var debug;
var host;
var port;
var sendTimeoutInSeconds = 1;
var rules = [];
var metricsLimit;
var sendLimitErrors;
var nriStats = {};

var logRequestInfo = function nriRequestInfo(req) {
  return req.method + ' http://' + req.getHeader('host') + '' + req.path
};

var parseTags = function parseTags(namePlusTags) {
  var tags = {};
  if(namePlusTags.indexOf('#') >= 0) {
      var tagStrings = namePlusTags.split('#')[1].split(',');
      tagStrings.forEach(function(tag) {
        var splitTag = tag.split(":");
        if(splitTag.length == 2) {
          tags[splitTag[0]] = splitTag[1];
        }
      })
  }
  return tags;
}


var sendPayload = function nriSend(host, port, payload) {
  if (debug) {
    globalLogger.log('Sending payload: ' + payload);
  }
  var startTime = Date.now();
  var options = {
    host: host,
    port: port,
    path: '/v1/data',
    method: 'POST',
    headers: {
      'Content-Length': Buffer.byteLength(payload),
      'Content-Type': 'application/json',
      'User-Agent': 'StatsD-backend'
    }
  };
  var req = http.request(options, function(res) {
    var resData = "";
    res.on('data', function(d) {
      resData += d;
    });
    res.on('end', function() {
      switch (Math.floor(res.statusCode / 100)) {
      case 5:
        if (debug) {
          globalLogger.log('Unexpected error from New Relic Infrastructure Agent. HTTP ' + res.statusCode + ' error: ' + resData);
        }
        nriStats.last_exception = Math.round(Date.now() / 1000);
        break;
      case 4:
        if (debug) {
          globalLogger.log('Error sending JSON payload to New Relic Infrastructure Agent (' + logRequestInfo(req) + '). HTTP ' + res.statusCode + ' error: ' + resData);
        }
        nriStats.last_exception = Math.round(Date.now() / 1000);
        break;
      case 2:
        if (debug) {
          globalLogger.log('Payload sent successfully');
        }
        break;
      default:
        if (debug) {
          globalLogger.log('Unexpected response from New Relic Infrastructure Agent. HTTP ' + res.statusCode + ' error: ' + resData);
        }
      }
    });
  });
  req.on('error', function(e) {
    if (debug) {
      globalLogger.log('Unexepected error requesting New Relic Infrastructure Agent. Error: ' + e.message);
    }
  });
  req.setTimeout(sendTimeoutInSeconds * 1000, function() {
    if (debug) {
      globalLogger.log('Request timed out sending JSON payload to New Relic Infrastructure agent');
    }
    req.end();
  });
  req.write(payload);
  req.end();
  nriStats.flush_time = Math.round(Date.now() - startTime);
  nriStats.flush_length = payload.length;
  nriStats.last_flush = Math.round(Date.now() / 1000);
};

var collectMetrics = function nriCollectMetrics(rawMetrics, rules) {
  var gauges = rawMetrics.gauges || {};
  var counters = rawMetrics.counters || {};
  var counterRates = rawMetrics.counter_rates;
  var timerData = rawMetrics.timer_data || {};
  var sets = rawMetrics.sets || {};
  var data = {};

  var ruleTemplate = function evalSchema(tpl, metricData) {
    var re = /{([^}]+)?}/g;
    var match;
    var result = tpl;
    while ((match = re.exec(tpl))) {
      result = result.replace(match[0], metricData[match[1]]);
    }
    return result;
  };
  var validateKeyWithSchema = function validate(key, schema) {
    var splittedSchema = schema.split('.');
    var splittedKey = key.split('.');

    return splittedKey.length >= splittedSchema.length;
  };
  var extractSchemaFields = function(key, schema) {
    var splittedSchema = schema.split('.');
    var splittedKey = key.split('.');
    var fields = {};
    splittedSchema.forEach(function(sword, idx) {
      var word = sword.match(/{([^}]*).*/);
      var value;
      if (word !== null) {
        word = word[1];
        if (idx + 1 === splittedSchema.length && idx + 1 < splittedKey.length) {
          value = splittedKey.slice(idx, splittedKey.length).join('.');
        } else {
          value = splittedKey[idx];
        }
        fields[word] = value;
      }
    });
    return fields;
  };
  //labelsFromMetric is an optional hash with labels directly from the metric
  var evalRule = function evalRule(rule, metricName, value, labelsFromMetric) {
    var re = new RegExp(rule.matchExpression);
    var found = re.test(metricName);

    if (found) {
      if (validateKeyWithSchema(metricName, rule.metricSchema)) {
        var metricFields = extractSchemaFields(metricName, rule.metricSchema);
        var eventType = rule.eventType;
        if (debug) {
          if (/{.*}/.test(eventType)) {
            globalLogger.log('You can\'t use variable substitutions for EventType: ${rule.eventType}');
          }
        }
        var entityName = ruleTemplate(rule.entityName, metricFields);
        var entityType = ruleTemplate(rule.entityType, metricFields);
        var entityId = entityType + ':' + entityName;
        if(Object.keys(labelsFromMetric).length > 0) {
          entityId = entityId +":" + JSON.stringify(labelsFromMetric);
        }

        metricFields[metricFields.metricName] = value;
        delete metricFields.metricName;

        if (data.hasOwnProperty(entityId)) {
          if (!data[entityId].metrics.hasOwnProperty(eventType)) {
            data[entityId].metrics[eventType] = {};
          }
          Object.assign(data[entityId].metrics[eventType], metricFields);
        } else {
          data[entityId] = {
            entity: { name: entityName, type: entityType },
            metrics: {}
          };
          data[entityId].metrics[eventType] = metricFields;
        }

        Object.keys(rule.labels || {}).forEach(function(label) {
          data[entityId].metrics[eventType]['label.' + label] = ruleTemplate(rule.labels[label], metricFields);
        });
        Object.keys(labelsFromMetric).forEach(function(labelName) {
          data[entityId].metrics[eventType]['label.' + labelName] = labelsFromMetric[labelName]
        });
      } else if (debug) {
        globalLogger.log("It isn't possible to compose an event for key " + metricName + ". It has less elements than metric schema: " + rule.metricSchema);
      }
    }

    return found;
  };

  if (debug) {
    var expressions = rules.map(function(rule) { return rule.matchExpression; });
    globalLogger.log('Matching keys against rule expressions: [' + expressions.join(', ') + ']');
  }

  var matchedKeys = 0;

  Object.keys(counters).forEach(function(namePlusTags) {
    var metricName = namePlusTags.split('#')[0]
    var tags = parseTags(namePlusTags)

    rules.forEach(function(rule) {
      if (evalRule(rule, metricName, counters[namePlusTags], tags)) {
        evalRule(rule, metricName + 'PerSecond', counterRates[namePlusTags], tags);
        matchedKeys++;
      }
    });
  });

  Object.keys(timerData).forEach(function(namePlusTags) {
    var metricName = namePlusTags.split('#')[0]
    var tags = parseTags(namePlusTags)
    rules.forEach(function(rule) {
      Object.keys(timerData[namePlusTags]).forEach(function(timerKey) {
        evalRule(rule, metricName + '.' + timerKey, timerData[namePlusTags][timerKey], tags);
      });
    });
  });

  Object.keys(gauges).forEach(function(namePlusTags) {
    var metricName = namePlusTags.split('#')[0]
    var tags = parseTags(namePlusTags)
    rules.forEach(function(rule) {
      evalRule(rule, metricName, gauges[namePlusTags], tags);
    });
  });

  Object.keys(sets).forEach(function(namePlusTags) {
    var metricName = namePlusTags.split('#')[0]
    var tags = parseTags(namePlusTags)
    rules.forEach(function(rule) {
      evalRule(rule, metricName + '.count', sets[namePlusTags].size(), tags);
    });
  });

  if (debug) {
    var totalKeys = Object.keys(counters).length + Object.keys(timerData).length + Object.keys(gauges).length + Object.keys(sets).length;
    globalLogger.log('Matched keys ' + matchedKeys + '. Total keys: ' + totalKeys);
  }

  return data;
};

var composePayload = function nriPayload(data) {
  var defaultIntegration = {
    name: 'com.newrelic.statsd',
    integration_version: '0.1.0',
    protocol_version: '1'
  };

  var v1Payload = function(v1data) {
    var integration = Object.assign({}, defaultIntegration);
    var metricSets = [];

    Object.keys(v1data).forEach(function(entityId) {
      var metrics = v1data[entityId].metrics;
      Object.keys(metrics).forEach(function(eventType) {
        var values = metrics[eventType];
        var metricsLength = Object.keys(values).length;

        if (metricsLength > metricsLimit) {
          if (sendLimitErrors) {
            metricSets.push(
              {
                event_type: "StatsdLimitErrorSample",
                numberOfMetrics: metricsLength,
                configuredLimit: metricsLimit,
              }
            )
          }
          if (debug) {
            globalLogger.log("The event has more than " + metricsLimit + " metrics and can't be processed. Metrics length: " + metricsLength);
          }
          nriStats.last_exception = Math.round(Date.now() / 1000);
        } else {
          metricSets.push(Object.assign({ event_type: eventType }, values));
        }
      });
    });
    return Object.assign(integration, { metrics: metricSets, inventory: {}, events: [] });
  };

  var v2Payload = function(v2data) {
    var integration = Object.assign({}, defaultIntegration);
    var entitiesData = [];

    Object.keys(v2data).forEach(function(entityId) {
      var metrics = v2data[entityId].metrics;
      var metricSets = [];
      Object.keys(metrics).forEach(function(eventType) {
        var entityName = v2data[entityId].entity.type + ':' + v2data[entityId].entity.name;
        var displayName = v2data[entityId].entity.name;
        var values = metrics[eventType];
        var metricsLength = Object.keys(values).length;
        if (metricsLength > metricsLimit) {
          if (sendLimitErrors) {
            metricSets.push(
              {
                event_type: "StatsdLimitErrorSample",
                entityName: entityName,
                displayName: displayName,
                numberOfMetrics: metricsLength,
                configuredLimit: metricsLimit
              }
            );
          }
          if (debug) {
            globalLogger.log("The event has more than " + metricsLimit + " metrics and can't be processed. Metrics length: " + metricsLength);
          }
        } else {
          var event = Object.assign({ event_type: eventType }, values);
          Object.assign(event,
                        { entityName: entityName,
                          displayName: displayName
                        });
          metricSets.push(event);
        }
      });

      entitiesData.push({
        entity: v2data[entityId].entity,
        metrics: metricSets,
        events: [],
        inventory: {}
      });
    });

    return Object.assign({}, integration, { protocol_version: '2', data: entitiesData });
  };

  return v1Payload(data);
};

var flushMetrics = function nriFlush(timestamp, rawMetrics) {
  if (rules.length === 0 && debug) {
    globalLogger.log("There are not rules configured for backend 'newrelic'. Without rules, we can not know how to process and send StatsD metrics to New Relic Infrastructure.");
  }
  var metricsByEntity = collectMetrics(rawMetrics, rules);
  var payload = composePayload(metricsByEntity);

  if ((payload.metrics && payload.metrics.length > 0) || (payload.data && payload.data.length > 0))  {
    sendPayload(host, port, JSON.stringify(payload));
  }

  return payload;
};

var backendStatus = function nriBackendStatus(writeCb) {
  Object.keys().forEach(function(stat) {
    writeCb(null, 'newrelic', stat, nriStats[stat]);
  });
};

exports.init = function nriInitBackend(startupTime, config, events, logger) {
  debug = config.debug;
  if (logger == null) {
    globalLogger = require('util');
  } else {
    globalLogger = logger;
  }

  if (config.newrelic) {
    host = config.newrelic.host || 'localhost';
    port = parseInt(config.newrelic.port, 10) || 8001;
    rules = config.newrelic.rules || [];
    metricsLimit = Number(config.newrelic.metricsLimit || 150)
    if (config.newrelic.sendLimitErrors == null) {
      sendLimitErrors = true;
    } else {
      sendLimitErrors = config.newrelic.sendLimitErrors;
    }
  }

  nriStats.last_flush = startupTime;
  nriStats.last_exception = startupTime;

  events.on('flush', flushMetrics);
  events.on('status', backendStatus);
  return true;
};
