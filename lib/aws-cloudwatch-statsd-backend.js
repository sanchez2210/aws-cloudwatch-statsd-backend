var util = require('util');
var AWS_SDK = require('aws-sdk');
var AWS = undefined;

function CloudwatchBackend(startupTime, config, emitter, logger) {
  var self = this;

  this.config = config || {};
  AWS.config = this.config;

  this.logger = logger;

  function setEmitter() {
    self.cloudwatch = new AWS.CloudWatch(self.config);
    emitter.on('flush', function(timestamp, metrics) { self.flush(timestamp, metrics); });
  }

  // if iamRole is set attempt to fetch credentials from the Metadata Service
  if (this.config.iamRole) {
    if (this.config.iamRole == 'any') {
      // If the iamRole is set to any, then attempt to fetch any available credentials
      ms = new AWS.EC2MetadataCredentials();
      ms.refresh(function(err) {
        if (err) {
          self.logger.log('Failed to fetch IAM role credentials: ' + err, 'ERROR');
        }
        self.config.credentials = ms;
        setEmitter();
      });
    } else {
      // however if it's set to specify a role, query it specifically.
      ms = new AWS.MetadataService();
      ms.request('/latest/meta-data/iam/security-credentials/' + this.config.iamRole, function(err, rdata) {
        var data = JSON.parse(rdata);

        if (err) {
          self.logger.log('Failed to fetch IAM role credentials: ' + err, 'ERROR');
        }
        self.config.credentials = new AWS.Credentials(data.AccessKeyId, data.SecretAccessKey, data.Token);
        setEmitter();
      });
    }
  } else {
    setEmitter();
  }
};

CloudwatchBackend.prototype.processKey = function(key) {
  var parts = key.split(/[\.\/-]/);

  return {
    metricName: parts[parts.length - 1],
    namespace: parts.length > 1 ? parts.splice(0, parts.length - 1).join("/") : null
  };
};

CloudwatchBackend.prototype.isBlacklisted = function(key) {
  var blacklist = this.activeBlacklist();
  var blacklisted = false;

  // First check if key is whitelisted
  if (this.config.whitelist && this.config.whitelist.length > 0 && this.config.whitelist.indexOf(key) >= 0) {
      this.logger.log('Key (counter) ' + key + ' is whitelisted', 'DEBUG');
      return false;
  }

  for (var i = 0; i < blacklist.length; i++) {
    if (key.indexOf(blacklist[i]) >= 0) {
      blacklisted = true;
      break;
    }
  }
  return blacklisted;
};

CloudwatchBackend.prototype.activeBlacklist = function() {
  if (this.config.blacklist && this.config.blacklist.length > 0) {
    // return user-configured blacklist if available
    return this.config.blacklist;
  } else if (this.config.whitelist && this.config.whitelist.length > 0) {
    // if user configured a whitelist but no blacklist, that implies
    // blacklisting everything not explicitly whitelisted
    return [''];
  } else {
    // if neither list was configured, the default blocklist is empty
    return [];
  }
}

CloudwatchBackend.prototype.chunk = function(arr, chunkSize) {

  var groups = [],
    i;
  for (i = 0; i < arr.length; i += chunkSize) {
    groups.push(arr.slice(i, i + chunkSize));
  }
  return groups;
};

CloudwatchBackend.prototype.batchSend = function(currentMetricsBatch, namespace) {
  const self = this;

  // send off the array (instead of one at a time)
  if (currentMetricsBatch.length > 0) {

    // Chunk into groups of 20
    var chunkedGroups = this.chunk(currentMetricsBatch, 20);

    for (var i = 0, len = chunkedGroups.length; i < len; i++) {
      let payload = {
        MetricData: chunkedGroups[i],
        Namespace: namespace
      };

      this.logger.log(util.inspect(payload), 'DEBUG');

      this.cloudwatch.putMetricData(payload, function(err, data) {
        if (err) {
          // log an error
          self.logger.log(util.inspect(err), 'ERROR');
        } else {
          // Success
          self.logger.log(util.inspect(data), 'DEBUG');
        }
      });
    }
  }
};

CloudwatchBackend.prototype.flush = function(timestamp, metrics) {
  this.logger.log('Flushing metrics at ' + new Date(timestamp * 1000).toISOString(), 'INFO');
  this.logger.log(util.inspect(metrics), 'DEBUG');

  var counters = metrics.counters;
  var gauges = metrics.gauges;
  var timers = metrics.timers;
  var sets = metrics.sets;

  // put all currently accumulated counter metrics into an array
  var currentNamespaces = {};
  var namespace = "AwsCloudWatchStatsdBackend";
  for (key in counters) {

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    if (!currentNamespaces.hasOwnProperty(namespace)) currentNamespaces[namespace] = []

    currentNamespaces[namespace].push({
      MetricName: metricName,
      Unit: 'Count',
      Timestamp: new Date(timestamp * 1000).toISOString(),
      Value: counters[key]
    });
  }
  for (namespace in currentNamespaces){
    this.batchSend(currentNamespaces[namespace], namespace);
  }

  // put all currently accumulated timer metrics into an array
  currentNamespaces = {};
  for (key in timers) {
    if (timers[key].length > 0) {

      if (this.isBlacklisted(key)) {
        continue;
      }

      var values = timers[key].sort(function(a, b) {
        return a - b;
      });
      var count = values.length;
      var min = values[0];
      var max = values[count - 1];

      var cumulativeValues = [min];
      for (var i = 1; i < count; i++) {
        cumulativeValues.push(values[i] + cumulativeValues[i - 1]);
      }

      var sum = min;
      var mean = min;
      var maxAtThreshold = max;

      var message = "";

      var key2;

      sum = cumulativeValues[count - 1];
      mean = sum / count;

      var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
      namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
      var metricName = this.config.metricName || names.metricName || key;
      if (!currentNamespaces.hasOwnProperty(namespace)) currentNamespaces[namespace] = []

      currentNamespaces[namespace].push({
        MetricName: metricName,
        Unit: 'Milliseconds',
        Timestamp: new Date(timestamp * 1000).toISOString(),
        StatisticValues: {
          Minimum: min,
          Maximum: max,
          Sum: sum,
          SampleCount: count
        }
      });
    }
  }

  for (namespace in currentNamespaces){
    this.batchSend(currentNamespaces[namespace], namespace);
  }

  // put all currently accumulated gauge metrics into an array
  currentNamespaces = {};
  for (key in gauges) {

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    if (!currentNamespaces.hasOwnProperty(namespace)) currentNamespaces[namespace] = []

    currentNamespaces[namespace].push({
      MetricName: metricName,
      Unit: 'None',
      Timestamp: new Date(timestamp * 1000).toISOString(),
      Value: gauges[key]
    });
  }

  for (namespace in currentNamespaces){
    this.batchSend(currentNamespaces[namespace], namespace);
  }

  // put all currently accumulated set metrics into an array
  currentNamespaces = {};
  for (key in sets) {

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    if (!currentNamespaces.hasOwnProperty(namespace)) currentNamespaces[namespace] = []

    currentNamespaces[namespace].push({
      MetricName: metricName,
      Unit: 'None',
      Timestamp: new Date(timestamp * 1000).toISOString(),
      Value: sets[key].values().length
    });
  }

  for (namespace in currentNamespaces){
    this.batchSend(currentNamespaces[namespace], namespace);
  }
};

exports.init = function(startupTime, config, events, logger, aws) {
  AWS = aws || AWS_SDK;
  var cloudwatch = config.cloudwatch || {};
  var instances = cloudwatch.instances || [cloudwatch];
  for (key in instances) {
    instanceConfig = instances[key];
    logger.log('Starting cloudwatch reporter instance in region: ' + instanceConfig.region, 'INFO');
    var instance = new CloudwatchBackend(startupTime, instanceConfig, events, logger);
  }
  return true;
};
