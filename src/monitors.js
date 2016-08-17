
module.exports = {};

module.exports.lag = (monitor, series, provisionerId, region, az,
                      instanceType, workerType, id, didShow, lag) => {
  series({
    provisionerId,
    region,
    az,
    instanceType,
    workerType,
    id,
    didShow,
    lag,
  });
  monitor.measure(`${region}.lag`, lag);
  monitor.measure(`${region}.${az}.${instanceType}.lag`, lag);
  if (didShow) {
    monitor.count(`overall.didshow`, 1);
    monitor.count(`${region}.${az}.${instanceType}.didshow`, 1);
  } else {
    monitor.count(`overall.noshow`, 1);
    monitor.count(`${region}.${az}.${instanceType}.noshow`, 1);
  }
};

module.exports.spotRequestSubmitted = (monitor, series, provisionerId,
                                       region, az, instanceType, workerType, id, bid) => {
  series({
    provisionerId,
    region,
    az,
    instanceType,
    workerType,
    id,
    bid: bid.price,
    price: bid.truePrice,  // ugh, naming!
    bias: bid.bias,
  });
  monitor.measure('overall.price-per-capacity-unit', bid.truePrice);
  monitor.measure(`${region}.${az}.${instanceType}.overall.spot.bid`, bid.price);
  monitor.measure(`${region}.${az}.${instanceType}.overall.spot.price`, bid.truePrice);
  monitor.measure(`${region}.${az}.${instanceType}.overall.spot.bias`, bid.bias);
  monitor.measure(`${region}.${az}.${instanceType}.worker.${workerType}.spot.bid`, bid.price);
  monitor.measure(`${region}.${az}.${instanceType}.worker.${workerType}.spot.price`, bid.truePrice);
  monitor.measure(`${region}.${az}.${instanceType}.worker.${workerType}.spot.bias`, bid.bias);
};

module.exports.spotRequestFulfilled = (monitor, series, provisionerId, region, az,
                                       instanceType, workerType, id, instanceId, time) => {
  series({
    provisionerId,
    region,
    az,
    instanceType,
    workerType,
    id,
    instanceId,
    time,
  });
  monitor.count('overall.spot.died.count', 1);
  monitor.measure('overall.spot.died.time', time);
  monitor.count(`${region}.${az}.${instanceType}.overall.spot.filled.count`, 1);
  monitor.measure(`${region}.${az}.${instanceType}.overall.spot.filled.time`, time);
  monitor.count(`${region}.${az}.${instanceType}.worker.${workerType}.spot.filled.count`, 1);
  monitor.measure(`${region}.${az}.${instanceType}.worker.${workerType}.spot.filled.time`, time);
};

module.exports.spotRequestDied = (monitor, series, provisionerId, region, az,
                                  instanceType, workerType, id, time, bid, state,
                                  statusCode, statusMessage) => {
  series({
    provisionerId,
    region,
    az,
    instanceType,
    workerType,
    id,
    time,
    bid,
    state,
    statusCode,
    statusMsg,
  });
  monitor.count('overall.spot.died.count', 1);
  monitor.count(`${region}.${az}.${instanceType}.overall.spot.died`, 1);
  monitor.count(`${region}.${az}.${instanceType}.worker.${workerType}.spot.died`, 1);
};

module.exports.instanceTerminated = (monitor, series, provisionerId, region, az,
                                     instanceType, workerType, id, spotRequestId, time,
                                     launchTime, stateCode, stateMsg, stateChangeCode,
                                     stateChangeMsg) => {
  series({
    provisionerId,
    region,
    az,
    instanceType,
    workerType,
    id,
    spotRequestId,
    time,
    launchTime,
    stateCode,
    stateMsg,
    stateChangeCode,
    stateChangeMsg,
  });
  monitor.count('overall.instance.terminated', 1);
  monitor.count(`${region}.${az}.${instanceType}.overall.instance.terminated`, 1);
  monitor.count(`${region}.${az}.${instanceType}.worker.${workerType}.instance.terminated`, 1);
};

module.exports.spotFloorFound = (monitor, series, region, az, instanceType, time, price, reason) => {
  series({
    region,
    az,
    instanceType,
    time,
    price,
    reason,
  });
  monitor.measure(`overall.spot.${instanceType}.price-floor`, price);
  monitor.measure(`${region}.${az}.${instanceType}.price-floor`, price);
};

module.exports.amiUsage = (monitor, series, provisionerId, region, az, instanceType, workerType, ami) => {
  series({
    provisionerId,
    ami,
    region,
    az,
    instanceType,
    workerType,
  });
  monitor.count(`${region}.ami.${ami}`, 1);
  monitor.count(`${region}.${az}.${instanceType}.worker.${workerType}.ami.${ami}`, 1);
};
