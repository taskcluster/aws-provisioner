'use strict';

var Promise = require('promise');
var lodash = require('lodash');
var util = require('util');
var Cache = require('../cache');
var assert = require('assert');


function fetchPricing(ec2) {
  var that = this;
  // We wrap this instead of the raw ec2 method in a cache
  // because we need the start date to be updated
  var startDate = new Date();
  startDate.setHours(startDate.getHours() - 2);
  var requestObj = {
    StartTime: startDate,
    Filters: [{
      Name: 'product-description',
      Values: ['Linux/UNIX'],
    }],
  }
  var p = ec2.describeSpotPriceHistory(requestObj);

  p = p.then(function(pricing) {
    var regions = Object.keys(pricing);
    var fixed = {};

    // Get rid of the key we don't care about
    regions.forEach(function(region) {
      fixed[region] = pricing[region].SpotPriceHistory;
    });

    return new AwsPricing(ec2.regions, fixed);
  })

  return p;
}

module.exports = fetchPricing;

function AwsPricing(regions, pricing) {
  this.__pricing = pricing;
  this.regions = regions;
}


/**
 * Get the pricing dictionary
 */
AwsPricing.prototype.get = function () {
  return this.__pricing;
};


/**
 * Build a dictionary of average pricing for each type in each region
 * We should do smart things like:
 *    - weight each AZ's price by how long it was the price
 *    - do other smart things
 *    - break it down by AZ and region for optimal data
 * NOTE: Should do something better about availability zones
 */
AwsPricing.prototype.pricesByRegionAndType = function() {
  var that = this;

  var pricing = {};

  this.regions.forEach(function(region) {
    pricing[region] = {};
    var rPricing = {}

    that.__pricing[region].forEach(function(pricePoint) {
      var type = pricePoint.InstanceType;
      var price = parseFloat(pricePoint.SpotPrice);
      if (rPricing[type]) {
        rPricing[type].sum += price;
        rPricing[type].count++;
      } else {
        rPricing[type] = {
          sum: price,
          count: 1,
        };
      }
    });

    Object.keys(rPricing).forEach(function(type) {
      pricing[region][type] = rPricing[type].sum / rPricing[type].count;
    });
  });

  return pricing;

};
