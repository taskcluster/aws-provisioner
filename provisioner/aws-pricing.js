'use strict';

var Promise = require('promise');
var lodash = require('lodash');
var util = require('util');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:aws-pricing');


function fetchPricing(ec2) {
  var that = this;
  var startDate = new Date();
  startDate.setMinutes(startDate.getMinutes() - 30);
  var requestObj = {
    StartTime: startDate,
    Filters: [{
      Name: 'product-description',
      Values: ['Linux/UNIX'],
    }],
  }

  var p = Promise.all([
    ec2.describeSpotPriceHistory(requestObj),
    ec2.describeAvailabilityZones({
      Filters: [{
        Name: 'state',
        Values: ['available'],
      }],
    }),
  ]);

  p = p.then(function(res) {
    var pricing = res[0];
    var availableAvailZones = res[1]
    var regions = Object.keys(pricing);
    var fixed = {};
    var zoneInfo = {};

    // Get rid of the key we don't care about
    regions.forEach(function(region) {
      fixed[region] = pricing[region].SpotPriceHistory;
      zoneInfo[region] = availableAvailZones[region].AvailabilityZones.map(function(x) {
        return x.ZoneName;
      });
    });


    return new AwsPricing(ec2.regions, fixed, zoneInfo);
  })

  return p;
}

module.exports = fetchPricing;

function AwsPricing(regions, pricing, zoneInfo) {
  assert(regions);
  assert(pricing);
  assert(zoneInfo);
  this.__pricing = pricing;
  this.regions = regions;
  this.__zoneInfo = zoneInfo;
}


/**
 * Get the pricing dictionary... This is a little ugly
 * but it works... Ideas welcomed
 */
AwsPricing.prototype.get = function () {
  return this.__pricing;
};

/**
 * List the available availability zones
 */
AwsPricing.prototype.availableAvailabilityZones = function() {
  var that = this;
  var zones = [];
  Object.keys(this.__zoneInfo).forEach(function(region) {
    Array.prototype.push.apply(zones, that.availableAvailabilityZonesInRegion(region)); 
  });
  return zones;
};


/**
 * List the available availability zones in one region
 */
AwsPricing.prototype.availableAvailabilityZonesInRegion = function(region) {
  return this.__zoneInfo[region];
};

/**
 * Build a dictionary of the max prices.  These are classified by
 * region, type then availability zone.  We take the max instead of
 * average to account for fluctuations in price.  A lot of times,
 * the spot price will go from X to 7X then back to X.  Because we
 * don't want to bid X, get killed when it goes to 7X, we should
 * consider only the peak pricing.  Since we're only fetching a
 * specified amount of time in the original request, we limit history
 * that way.  Wouldn't it be nifty to have an arg to this function that
 * let you specify (regardless of fetched history) the earliest 
 * point in time to consider for the max finding
 */
AwsPricing.prototype.maxPrices = function() {
  var that = this;

  var pricing = {};
  var zones = this.availableAvailabilityZones();

  // Sort the pricing points
  this.regions.forEach(function(region) {
    pricing[region] = {};
    that.__pricing[region].forEach(function(pricePoint) {
      var type = pricePoint.InstanceType;
      var price = pricePoint.SpotPrice;
      var zone = pricePoint.AvailabilityZone;
      if (!pricing[region][type]) {
        pricing[region][type] = {};
      }
      if (!pricing[region][type][zone]) {
        pricing[region][type][zone] = [];
      }
      pricing[region][type][zone].push(price); 
    });
  });

  // Find the max values
  var maxes = {};
  Object.keys(pricing).forEach(function(region) {
    maxes[region] = {};
    Object.keys(pricing[region]).forEach(function(type) {
      maxes[region][type] = {};
      Object.keys(pricing[region][type]).forEach(function(zone) {
        if (zones.includes(zone)) {
          maxes[region][type][zone] = Math.max.apply(null, pricing[region][type][zone]);
        } else {
          debug('availability zone %s has pricing data but is not listed as available');
        }
      });
    });
  });

  return maxes;
};
