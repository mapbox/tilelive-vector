var fs = require('fs');
var util = require('util');
var path = require('path');
var gm = require('gm');
var exec = require('child_process').exec;
var existsSync = require('fs').existsSync || require('path').existsSync

var graphics_magick_available = true;
var overwrite = false;

exec('gm compare -help', function(error, stdout, stderr) {
    if (error !== null) {
      graphics_magick_available = false;
    }
});

module.exports = function imageEqualsFile(buffer, fixture, callback) {
    var fixturesize = fs.statSync(fixture).size;
    var sizediff = Math.abs(fixturesize - buffer.length) / fixturesize;
    if (sizediff > 0.10) {
        return callback(new Error('Image size is too different from fixture: ' + buffer.length + ' vs. ' + fixturesize));
    }

    if (!graphics_magick_available) {
        throw new Error("graphicsmagick 'compare' tool is not available, please install before running tests");
    }
    
    var type = path.extname(fixture);
    var actual = path.join(path.dirname(fixture), path.basename(fixture, type) + '.result' + type);
    fs.writeFile(actual, buffer, function(err) {
        if (err) return callback(err);
        var tolerance = 0.008;
        gm.compare(fixture, actual, tolerance, function(err, isEqual, equality, raw) {
            if (err) return callback(err);
            // Clean up old failures.
            if (existsSync(actual)) fs.unlinkSync(actual);
            if (!isEqual) {
                return callback(new Error('Image is too different from fixture: ' + equality + ' > ' + tolerance));
            }
            callback();
        });
    });
};
