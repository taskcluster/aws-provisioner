var base = require('taskcluster-base');
var workerType = require('../lib/worker-type');
var slugid = require('slugid');
var mock = require('./mock-workers');
var main = require('../lib/main');

// for convenience
var makeRegion = mock.makeRegion;
var makeInstanceType = mock.makeInstanceType;
var makeWorkerType = mock.makeWorkerType;

function createMockBiaser(bias) {
  return {
    getBias: function() {
      return bias;
    },
  };
}

describe('worker type', function() {
  let subject;

  before(async () => {
    subject = await main('WorkerType', {process: 'WorkerType', profile: 'test'});
  });

  // This duplicates the api test a little i guess but why not :/
  it('should be able to be created, updated and deleted', async function () {
    var wType = makeWorkerType({
      lastModified: new Date(),
      regions: [makeRegion()],
      instanceTypes: [makeInstanceType()],
    });

    var wName = slugid.v4();

    var asCreated = await subject.create(wName, wType);
    var asLoaded = await subject.load({workerType: wName});

    asCreated.should.eql(asLoaded);

    var asModified = await asLoaded.modify(w => {
      w.lastModified = new Date();
      w.minCapacity++;
    });

    asModified.minCapacity.should.equal(wType.minCapacity + 1);

    return await asModified.remove();
  });

  describe('generating launch specifications', function() {
    it('should create a launch spec with valid data', async function () {
      var wType = makeWorkerType({
        lastModified: new Date(),
        instanceTypes: [makeInstanceType({instanceType: 'c3.small'}), makeInstanceType({instanceType: 'c3.medium'})],
        regions: [makeRegion({region: 'us-west-1'}), makeRegion({region: 'eu-central-1'})],
      });
      subject.testLaunchSpecs(wType, 'keyPrefix', 'provisionerId', 'url', 'ssh-rsa fakepubkey comment', 'workerName');
    });

    function shouldThrow(wType) {
      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        subject.testLaunchSpecs(wType, 'keyPrefix', 'provisionerId');
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */
    }

    it('should fail with duplicate instance type', async function () {
      var wType = makeWorkerType({
        instanceTypes: [makeInstanceType({instanceType: 'c3.small'}), makeInstanceType({instanceType: 'c3.small'})],
        regions: [makeRegion({region: 'us-west-1'}), makeRegion({region: 'eu-central-1'})],
      });
      shouldThrow(wType);
    });

    it('should fail with duplicate region', async function () {
      var wType = makeWorkerType({
        instanceTypes: [makeInstanceType({instanceType: 'c3.small'}), makeInstanceType({instanceType: 'c3.medium'})],
        regions: [makeRegion({region: 'us-west-1'}), makeRegion({region: 'us-west-1'})],
      });
      shouldThrow(wType);
    });

    it('should fail with region specific key in general', function() {
      var wType = makeWorkerType({
        launchSpec: {
          ImageId: 'ami-1234579',
        },
      });
      shouldThrow(wType);
    });

    it('should fail with region specific key in instance type', function() {
      var wType = makeWorkerType({
        instanceTypes: [makeInstanceType({launchSpec: {ImageId: 'ami-1234558'}})],
      });
      shouldThrow(wType);
    });

    it('should fail with instance type specific key in region', function() {
      var wType = makeWorkerType({
        regions: [makeRegion({launchSpec: {InstanceType: 'c3.small'}})],
      });
      shouldThrow(wType);
    });

    it('should fail with instance type specific key in general', function() {
      var wType = makeWorkerType({
        launchSpec: {
          InstanceType: 'ami-1234558',
        },
      });
      shouldThrow(wType);
    });

    /** THESE TESTS SHOULD WORK
    it('should not allow unknown keys', function () {
      var wType = makeWorkerType({
        DisavowedAgent: 'Ethan Hunt',
      });
      shouldThrow(wType);
    });

    it('should not allow disallowed keys', function () {
      var wType = makeWorkerType({
        Placement: 'Ethan Hunt',
      });
      shouldThrow(wType);
    });
    ** THESE TESTS ABOVE SHOULD WORK */

    it.skip('should create valid user data', function() {
      var wType = makeWorkerType({
        lastModified: new Date(),
        instanceTypes: [makeInstanceType({instanceType: 'c3.small'}), makeInstanceType({instanceType: 'c3.medium'})],
        regions: [makeRegion({region: 'us-west-1'}), makeRegion({region: 'eu-central-1'})],
      });
      var launchSpec = subject.createLaunchSpec({
        region: 'us-west-1',
        type: 'c3.small',
        zone: 'fakezone',
      }, wType, 'keyPrefix', 'provisionerId', 'url', 'ssh-rsa fakepubkey comment', 'name').launchSpec;
      var userData = JSON.parse(new Buffer(launchSpec.UserData, 'base64').toString());

      userData.capacity.should.equal(1);
      userData.provisionerId.should.equal('provisionerId');
      userData.region.should.equal('us-west-1');
      userData.instanceType.should.equal('c3.small');
    });

  });

  describe('convenience methods', function() {
    var wType;
    var wName;

    // To ensure cleanup without having to do .remove()
    // in each test, we'll create and delete in the before/after
    // hooks and use modify in each test
    beforeEach(async function () {
      wName = slugid.v4();
      wType = await subject.create(wName, makeWorkerType({
        lastModified: new Date(),
      }));
    });

    afterEach(async function () {
      await wType.remove();
    });

    it('getting region object', async function () {
      var wt = await wType.modify(w => {
        w.regions = [makeRegion({region: 'moon-3'})];
      });

      wt.getRegion('moon-3').should.be.an.Object; // eslint-disable-line no-unused-expressions
      wt.getRegion('moon-3').region.should.equal('moon-3');

      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.getRegion('notvalid');
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */
    });

    it('getting instance type object', async function () {
      var wt = await wType.modify(w => {
        w.instanceTypes = [makeInstanceType({instanceType: 't1.micro'})];
      });

      wt.getInstanceType('t1.micro').should.be.an.Object; // eslint-disable-line no-unused-expressions
      wt.getInstanceType('t1.micro').instanceType.should.equal('t1.micro');

      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.getinstanceType('notvalid');
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */
    });

    it('getting capacity of an instance type', async function () {
      var wt = await wType.modify(w => {
        w.instanceTypes = [makeInstanceType({instanceType: 'c3.small', capacity: 5})];
      });

      wt.capacityOfType('c3.small').should.equal(5);

      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.capacityOfType('notvalid');
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */

    });

    it('getting utility factor of an instance type', async function () {
      var wt = await wType.modify(w => {
        w.instanceTypes = [makeInstanceType({instanceType: 'c3.small', utility: 4})];
      });

      wt.utilityOfType('c3.small').should.equal(4);

      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.utilityOfType('notvalid');
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */

    });

    it('should return a json representation of itself', function() {
      wType.json().should.be.an.Object; //eslint-disable-line no-unused-expressions
      wType.json().should.have.property('workerType');
      wType.json().should.not.have.property('__properties');
    });
  });

  describe('determining capacity change', function() {
    var wType;
    var wName;

    // To ensure cleanup without having to do .remove()
    // in each test, we'll create and delete in the before/after
    // hooks and use modify in each test
    beforeEach(async function () {
      wName = slugid.v4();
      wType = await subject.create(wName, makeWorkerType({
        lastModified: new Date(),
      }));
    });

    afterEach(async function () {
      await wType.remove();
    });

    function testChange(expected, rCap, pCap, pend, min, max, sr) {
      it(rCap + ' runningCap ' + pCap + ' pendingCap ' + pend + ' pending ==> ' +
         expected + ' ratio ' + (sr || 0) + ' min/max ' + (min || 0) + '/' + (max || 20), async function () {
        var wt = await wType.modify(w => {
          w.minCapacity = min || 0;
          w.maxCapacity = max || 20;
          w.scalingRatio = sr || 0;
        });
        wt.determineCapacityChange(rCap, pCap, pend).should.equal(expected);
      });
    }

    describe('no scaling ratio', function() {
      testChange(0, 0, 0, 0);
      testChange(1, 0, 0, 0, 1);
      testChange(5, 0, 0, 5);
      testChange(5, 5, 0, 5);
      testChange(0, 5, 5, 5);
      testChange(0, 0, 5, 5);
      testChange(-5, 0, 10, 5);
      testChange(-5, 5, 10, 5);
      testChange(20, 0, 0, 20, 1, 20);
      testChange(20, 0, 0, 30, 1, 20);
    });

    describe('20% scaling ratio', function() {
      testChange(0, 0, 0, 0, 0, 1000, 0.2);
      testChange(1, 0, 0, 0, 1, 1000, 0.2);
      //testChange(80, 0, 0, 100, 0, 1000, 0.2); // why doesn't this work
      //testChange(40, 0, 40, 100, 0, 1000, 0.2); // why doesn't this work
      testChange(1000, 0, 0, 10000, 0, 1000, 0.2);
      testChange(960, 0, 40, 10000, 0, 1000, 0.2);
    });

    describe('-20% scaling ratio', function() {
      testChange(0, 0, 0, 0, 0, 1000, -0.2);
      testChange(1, 0, 0, 0, 1, 1000, -0.2);
      //testChange(120, 0, 0, 100, 0, 1000, -0.2); // why doesn't this work
      //testChange(80, 0, 40, 100, 0, 1000, -0.2); // why doesn't this work
      testChange(1000, 0, 0, 10000, 0, 1000, 0.2);
      testChange(960, 0, 40, 10000, 0, 1000, 0.2);
    });

  });

  function fakePricing(silly) {
    var d;
    if (silly) {
      d = {
        region1: {
          type1: {
            zone1: 1000,
          },
        },
      };
    } else {
      d = {
        region1: {
          type1: {
            zone1: 5,
            zone2: 6,
          },
          type2: {
            zone2: 3,
          },
        },
        region2: {
          type2: {
            zone3: 2,
          },
        },
        region3: {
        },
      };
    }
    return d;
  }

  describe('determining spot bids', function() {
    var wType;
    var wName;

    // To ensure cleanup without having to do .remove()
    // in each test, we'll create and delete in the before/after
    // hooks and use modify in each test
    beforeEach(async function () {
      wName = slugid.v4();
      wType = await subject.create(wName, makeWorkerType({
        maxPrice: 6,
        lastModified: new Date(),
        regions: [
          makeRegion({region: 'region1'}),
          makeRegion({region: 'region2'}),
          makeRegion({region: 'region3'}),
        ],
        instanceTypes: [
          makeInstanceType({instanceType: 'type1', capacity: 1, utility: 1}),
          makeInstanceType({instanceType: 'type2', capacity: 2, utility: 2}),
        ],
      }));
    });

    afterEach(async function () {
      await wType.remove();
    });

    it('should pick the cheapest region, zone and type in one region', function() {
      var actual = wType.determineSpotBids(['region1'], fakePricing(), 1, createMockBiaser(1));
      var expected = [
        {
          bias: 1,
          region: 'region1',
          type: 'type2',
          zone: 'zone2',
          price: 6,  // Remember this is 2x the max bid
          truePrice: 1.5, // remember this is max bid price / utility
        },
      ];
      expected.should.eql(actual);
    });

    it('should pick the cheapest region, zone and type in two regions', function() {
      var actual = wType.determineSpotBids(['region1', 'region2'], fakePricing(), 1, createMockBiaser(1));
      var expected = [
        {
          bias: 1,
          region: 'region2',
          type: 'type2',
          zone: 'zone3',
          price: 4,  // Remember this is 2x the max bid
          truePrice: 1, // remember this is max bid price / utility
        },
      ];
      expected.should.eql(actual);
    });

    it('should work with an empty region', function() {
      var actual = wType.determineSpotBids(['region1', 'region3'], fakePricing(), 1, createMockBiaser(1));
      var expected = [
        {
          bias: 1,
          region: 'region1',
          type: 'type2',
          zone: 'zone2',
          price: 6,  // Remember this is 2x the max bid
          truePrice: 1.5, // remember this is max bid price / utility
        },
      ];
      expected.should.eql(actual);
    });

    it('should use the minPrice as lower bounds', async function () {
      var wt = await wType.modify(w => {
        w.maxPrice = 10;
        w.minPrice = 8;
      });
      var actual = wt.determineSpotBids(['region2'], fakePricing(), 1, createMockBiaser(1));
      var expected = [
        {
          bias: 1,
          region: 'region2',
          type: 'type2',
          zone: 'zone3',
          price: 4,  // Remember this is 2x the max bid,
          truePrice: 1, // this is max bid price / utility,
        },
      ];
      expected.should.eql(actual);
    });

    it('throw when no bid can be created because of max price', async function () {
      var wt = await wType.modify(w => {
        w.maxPrice = 0.1;
      });
      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.determineSpotBids(['region1', 'region2'], fakePricing(), 1);
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */
    });

    it('throw when we hit sanity threshold no matter what', async function () {
      var wt = await wType.modify(w => {
        w.maxPrice = 100000;
      });
      /* eslint-disable no-extra-parens, no-wrap-func */
      (function() {
        wt.determineSpotBids(['region1', 'region2'], fakePricing(true), 1);
      }).should.throw();
      /* eslint-enable no-extra-parens, no-wrap-func */
    });
  });
});
