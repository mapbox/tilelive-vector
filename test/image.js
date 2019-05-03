const fs = require('fs');
const util = require('util');
const path = require('path');
const spawn = require('child_process').spawn;
const exec = require('child_process').exec;
const existsSync = require('fs').existsSync || require('path').existsSync;
const mapnik = require('mapnik');

function imageEqualsFile(buffer, file, meanError, callback) {
    if (typeof meanError == 'function') {
        callback = meanError;
        meanError = 0.05;
    }

    const fixturesize = fs.statSync(file).size;
    const sizediff = Math.abs(fixturesize - buffer.length) / fixturesize;
    if (sizediff > meanError) {
        return callback(new Error('Image size is too different from fixture: ' + buffer.length + ' vs. ' + fixturesize));
    }
    const expectImage = new mapnik.Image.fromBytesSync(fs.readFileSync(file));
    const resultImage = new mapnik.Image.fromBytesSync(buffer);
    const pxDiff = expectImage.compare(resultImage);

    // Allow < 2% of pixels to vary by > default comparison threshold of 16.
    const pxThresh = resultImage.width() * resultImage.height() * 0.02;

    if (pxDiff > pxThresh) {
        callback(new Error('Image is too different from fixture: ' + pxDiff + ' pixels > ' + pxThresh + ' pixels'));
    } else {
        callback();
    }
}

module.exports = imageEqualsFile;
