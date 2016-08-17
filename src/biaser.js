let log = require('./log');
let assert = require('assert');
let _ = require('lodash');

/**
 * A biaser is an object which understands how much we should multiply the
 * calculated capacity unit price by to determine the price for comparison.
 * A calculated capacity unit price is the price that we compute by dividing
 * the price that amazon charges for that instance type by the utility factor
 * for that instance type in the workerType definition.
 */
class Biaser {
  constructor(cfg) {
    // Store a taskcluster-base.stats Influx object that the queries will be run
    // against
    assert(cfg.influx);
    this.influx = cfg.influx;

    // Max bias age is how long we should keep holding onto bias tables when we
    // can't fetch new tables
    assert(cfg.maxBiasAge);
    assert(typeof cfg.maxBiasAge === 'number');
    this.__maxBiasAge = cfg.maxBiasAge;

    // Stats age is the string that forms part of an InfluxDB query that
    // specifies how long of a period that we should consider when we fetch data
    // for finding bias values
    assert(cfg.statsAge);
    assert(typeof cfg.statsAge === 'string');
    this.__statsAge = cfg.statsAge;

    // When we have kills and spawns, we take the percentage of killed jobs and
    // multiply it by this number to determine the bias.  Example: 16 kills, 233
    // spawns is roughly 0.06.  If we set this multipler to 2 we have a bias of
    // 1.12
    assert(cfg.killRateMultiplier);
    assert(typeof cfg.killRateMultiplier === 'number');
    this.__killRateMultiplier = cfg.killRateMultiplier;

    // We want to give preference to regions where we haven't spawned anything or
    // had any kills as a way to distribute load
    assert(cfg.emptyComboBias);
    assert(typeof cfg.emptyComboBias === 'number');
    this.__emptyComboBias = cfg.emptyComboBias;

    // Store an empty bias table.  A bias table is a nested object which is
    // organized by the keys Region, Zone and Type in that order.  Those three
    // keys make up something we call a combo here.  Each combo in the table has
    // an object which may have the kills and spawns properties.  Those
    // properties are the number of kills for that combo and the number of spawns
    // for that combo, respectively.  When a kills or spawns key is not defined,
    // a value of zero should be assumed
    this.__biasTable = {};

    // When we set this time to be so old, it will ensure that we short circuit
    // the bias calculations and return bias of one until we have fetched real
    // data
    this.__lastUpdated = new Date('2000-01-01');
  }

  /**
   * Return the bias for this combination of region, zone and type.  A bias is
   * a number greater than 0 which is multplied by the price computed to use to
   * compare different regions, zones and types.  This number has no basis in
   * reality and is determined by looking at datasources like how many spot
   * instance kills that combination has experienced.
   *
   * A bias of 1 means that there is no positive or negative information about
   * that combination.  A bias of less than 1 means that the combination is
   * especially good and should be given preference.  A bias greater than 1 is
   * a sign that a given combination is considered to be bad.
   *
   * If we haven't updated the bias information in more than twenty minutes we
   * assume that we no longer have valid biasing information and return a bias
   * of one.
   */
  getBias(region, zone, type) {
    assert(region);
    assert(zone);
    assert(type);

    // Calculate the max date that we should allow for this.__lastUpdated date
    let maxDate = new Date();
    maxDate.setMinutes(maxDate.getMinutes() - this.__maxBiasAge);

    // If we haven't gotten valid biasing data in more than 20 minutes we should
    // assume that it's no longer valid
    if (this.__lastUpdated < maxDate) {
      return 1;
    }

    // Look up the bias information
    if (_.get(this.__biasTable, [region, zone, type])) {
      let info = _.get(this.__biasTable, [region, zone, type]);

      let kills = info.kills || 0;
      let spawns = info.spawns || 0;

      // If we have no kills in this combo, we know that everthing is fine here
      // and is a non-biased value, but we don't really want to give it any
      // preference
      if (kills === 0) {
        return 1;
      }

      // If we have no spawns and no kills, we haven't been using this combo
      // much.  We're going to give it a slight bias towards being used in an
      // effort to spread the load around
      if (spawns === 0 && kills === 0) {
        return this.__emptyComboBias;
      }

      let killrate = kills / spawns;

      // The only case where we have Inifity is when we have kills without
      // spawns.  If that happens, we want to basically ignore this combo since
      // it's really bad!  We return the bias as being the number of kills to
      // ensure that in the case where all combos are in this state that we pick
      // the combo that is the least awful for two reasons: we should still
      // submit something and we want to pick the least awful combo.  When we
      // pick the least awful combo, we also ensure that we load spread the
      // failures around.
      if (killrate === Infinity) {
        return kills;
      }

      // If we are able to calculate what the bias is, we want to weigh it a
      // little heavier so that we avoid that combo and
      let bias = 1 + this.__killRateMultiplier * killrate;
      return bias;
    } else {
      // Like if we have zero spawns and zero kills, we want to give this combo
      // a slight preference
      return this.__emptyComboBias;
    }
  }

  /**
   * Given a set of instance types and regions, fetch the information needed to
   * determine a bias value
   */
  async fetchBiasInfo(azinfo, types) {
    let regions = Object.keys(azinfo);

    let biasTable = {};

    let spotKillQuery = [
      'select count(id) from AwsProvisioner.InstanceTerminated',
      'where time > now() - ' + this.__statsAge,
      'and stateChangeCode <> \'Client.UserInitiatedShutdown\'',
      'and stateChangeCode <> \'Client.InstanceInitiatedShutdown\'',
      'group by az, region, instanceType',
    ].join(' ');

    let spotFulfilledQuery = [
      'select count(id) from AwsProvisioner.SpotRequestsFulfilled',
      'where time > now() - ' + this.__statsAge,
      'group by az, region, instanceType',
    ].join(' ');

    let fullQuery = spotKillQuery + ' ; ' + spotFulfilledQuery;

    let results = await this.influx.query(fullQuery);
    assert(results);
    assert(results.length === 2);

    let kills = results[0];
    let spawns = results[1];

    // Validate that we got things in the shape we expect
    assert(kills.name === 'AwsProvisioner.InstanceTerminated');
    assert(kills.columns[1] === 'count');
    assert(kills.columns[2] === 'az');
    assert(kills.columns[3] === 'region');
    assert(kills.columns[4] === 'instanceType');
    for (let killpt of kills.points) {
      let killcount = killpt[1];
      let zone = killpt[2];
      let region = killpt[3];
      let type = killpt[4];
      _.set(biasTable, [region, zone, type, 'kills'], killcount);
    }

    // Validate that we got things in the shape we expect
    assert(spawns.name === 'AwsProvisioner.SpotRequestsFulfilled');
    assert(spawns.columns[1] === 'count');
    assert(spawns.columns[2] === 'az');
    assert(spawns.columns[3] === 'region');
    assert(spawns.columns[4] === 'instanceType');
    for (let spawnpt of spawns.points) {
      let spawncount = spawnpt[1];
      let zone = spawnpt[2];
      let region = spawnpt[3];
      let type = spawnpt[4];
      _.set(biasTable, [region, zone, type, 'spawns'], spawncount);
    }

    this.__lastUpdated = new Date();
    this.__biasTable = biasTable;
  }
}

module.exports = Biaser;
