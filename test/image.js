var fs = require('fs');
var util = require('util');
var path = require('path');
var gm = require('gm');
var mkdirp = require('mkdirp');
var crypto = require('crypto');

function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

module.exports = function imageEqualsFile(buffer, fixture, callback) {
    var fixturesize = fs.statSync(fixture).size;
    var sizediff = Math.abs(fixturesize - buffer.length) / fixturesize;
    if (sizediff > 0.10) {
        return callback(new Error('Image size is too different from fixture: ' + buffer.length + ' vs. ' + fixturesize));
    }

    var dir = '/tmp/tilelive-vector-compare';
    var actual = path.join(dir, md5(buffer));
    mkdirp(dir, function(err) {
      if (err) return callback(err);
      fs.writeFile(actual, buffer, function(err) {
          if (err) return callback(err);
          var tolerance = 0.008;
          gm.compare(fixture, actual, tolerance, function(err, isEqual, equality, raw) {
              if (err) return callback(err);
              if (!isEqual) {
                  return callback(new Error('Image is too different from fixture: ' + equality + ' > ' + tolerance));
              }
              callback();
          });
      });
    });
};
