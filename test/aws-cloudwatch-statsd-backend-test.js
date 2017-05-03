var backendInit = require('../lib/aws-cloudwatch-statsd-backend.js').init;
var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

chai.use(sinonChai);

describe('cloudwatch-backend', function() {
  beforeEach(function() {
    console = sinon.spy();
  });

  describe('no explicit whitelist or blacklist', function() {
    it('emits metrics when no white/blacklist specified', function() {
      var aws = stubAWS();
      var emitter = new MockEmitter();

      backendInit(0, basicConfig(), emitter, aws);
      emitter.flush(1, {
        counters: { 'my.metric': 42 },
        gauges: {},
        timers: {},
        sets: {},
      });

      expect(aws.CloudWatch().putMetricData).to.have.been.calledOnce;
      expect(aws.CloudWatch().putMetricData).to.have.been.calledWithMatch({
        MetricData: [
          {
            MetricName: 'my.metric',
            Unit: 'Count',
            Timestamp: tsToDate(1),
            Value: 42
          }
        ],
        Namespace: 'AwsCloudWatchStatsdBackend'
      }, sinon.match.func);
    });

    it('respects the blacklist', function() {
      var aws = stubAWS();
      var emitter = new MockEmitter();
      var config = basicConfig();

      config.cloudwatch.blacklist = ['my.metric'];

      backendInit(0, config, emitter, aws);
      emitter.flush(1, {
        counters: { 'my.metric': 42 },
        gauges: {},
        timers: {},
        sets: {},
      });

      expect(aws.CloudWatch().putMetricData).to.have.been.calledNever;
    });

    // red test right now
    it('respects the whitelist, which implies blacklist', function() {
      var aws = stubAWS();
      var emitter = new MockEmitter();
      var config = basicConfig();

      config.cloudwatch.whitelist = ['my.metric'];

      backendInit(0, config, emitter, aws);
      emitter.flush(1, {
        counters: { 'my.metric': 42, 'my.other': 99 },
        gauges: {},
        timers: {},
        sets: {},
      });

      expect(aws.CloudWatch().putMetricData).to.have.been.calledOnce;
      expect(aws.CloudWatch().putMetricData).to.have.been.calledWithMatch({
        MetricData: [
          {
            MetricName: 'my.metric',
            Unit: 'Count',
            Timestamp: tsToDate(1),
            Value: 42
          }
        ],
        Namespace: 'AwsCloudWatchStatsdBackend'
      }, sinon.match.func);
    });

    it('when whitelist & blacklist conflict, whitelist wins', function() {
      var aws = stubAWS();
      var emitter = new MockEmitter();
      var config = basicConfig();

      config.cloudwatch.whitelist = ['my.metric'];
      config.cloudwatch.blacklist = ['my.metric', 'my.other'];

      backendInit(0, config, emitter, aws);
      emitter.flush(1, {
        counters: { 'my.metric': 42, 'my.other': 99 },
        gauges: {},
        timers: {},
        sets: {},
      });

      expect(aws.CloudWatch().putMetricData).to.have.been.calledOnce;
      expect(aws.CloudWatch().putMetricData).to.have.been.calledWithMatch({
        MetricData: [
          {
            MetricName: 'my.metric',
            Unit: 'Count',
            Timestamp: tsToDate(1),
            Value: 42
          }
        ],
        Namespace: 'AwsCloudWatchStatsdBackend'
      }, sinon.match.func);
    });
  });

  function stubAWS() {
    return {
      CloudWatch: sinon.stub().returns({
        putMetricData: sinon.spy()
      }),
      Credentials: sinon.spy(),
      EC2MetadataCredentials: sinon.stub().returns({
        refresh: function(cb) {
          cb.apply(null, []);
        },
        request: function(cb) {
          throw "this path isn't stubbed yet";
        }
      }),
    };
  }

  function MockEmitter() {
    this.handlers = {};
  }

  MockEmitter.prototype.on = function(evName, cb) {
    this.handlers[evName] = this.handlers[evName] || [];
    this.handlers[evName].push(cb);
  };

  MockEmitter.prototype.flush = function(timestamp, metrics) {
    for (var i = 0; i < this.handlers.flush.length; i++) {
      this.handlers.flush[i].apply(this, [timestamp, metrics]);
    }
  }

  function tsToDate(timestamp) {
    return new Date(timestamp * 1000).toISOString();
  }

  function basicConfig() {
    return {
      cloudwatch: {
        iamRole: 'any',
        region: 'us-east-1'
      }
    };
  }
});
