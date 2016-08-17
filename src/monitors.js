
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
  monitor.measure(`${region}.${az}.${instanceType}.${workerType}.lag`, lag);
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
  monitor.measure(`${region}.${az}.${instanceType}.${workerType}.spot.bid`, bid.price);
  monitor.measure(`${region}.${az}.${instanceType}.${workerType}.spot.price`, bid.truePrice);
  monitor.measure(`${region}.${az}.${instanceType}.${workerType}.spot.bias`, bid.bias);
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
  monitor.measure(`${region}.${az}.${instanceType}.${workerType}.spot.filled`, time);
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
  monitor.count(`${region}.${az}.${instanceType}.${workerType}.spot.died`);
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
  monitor.count(`${region}.${az}.${instanceType}.${workerType}.instance.terminated`);
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
  monitor.count(`${region}.${az}.${instanceType}.${workerType}.ami.${ami}`);
};
