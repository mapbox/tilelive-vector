const test = require('tape');
const tilelive = require('@mapbox/tilelive');
const Vector = require('..');
const profiler = require('../tile-profiler');
const Testsource = require('./testsource');
const ss = require('simple-statistics');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const _ = require('underscore');

// Tilelive test source.
tilelive.protocols['test:'] = Testsource;

const xml = fs.readFileSync(path.resolve(__dirname + '/fixtures/a.xml'), 'utf8');

test('finds layer information', (t) => {
    new Vector({ uri:'test:///a', xml: xml }, (err, source) => {
        t.ifError(err);
        const cb = function(err, vtile, headers) {
            t.ifError(err);
            t.ok(vtile._layerInfo);
            t.end();
        };
        cb.profile = true;
        source.getTile(0,0,0,cb);
    });
});

test('returns expected layer information', (t) => {
    new Vector({ uri:'test:///a', xml: xml }, (err, source) => {
        t.ifError(err);
        source._backend.getTile(0,0,0, (err, vtile, headers) => {
            if (err) throw err;
            const tile = vtile;
            const layerInfo = profiler.layerInfo(tile);

            // Tile has a 'coastline' layer
            const coastline = _(layerInfo).where({ name: 'coastline' })[0];
            t.ok(coastline);

            // Tile contains 4177 features
            t.equal(coastline.coordCount.length, 1437);
            t.equal(coastline.features, 1437);

            // Longest/shortest features
            t.equal(ss.max(coastline.coordCount), 380);
            t.equal(ss.min(coastline.coordCount), 2);

            // Most/least duplication
            t.equal(ss.max(coastline.duplicateCoordCount), 0);
            t.equal(ss.min(coastline.duplicateCoordCount), 0);

            // Max/Min distance between consecutive coords
            const diff = Math.abs(ss.max(coastline.coordDistance) - 570446.5598775251);
            t.ok(diff < 0.1);
            t.equal(ss.min(coastline.coordDistance), 1181.6043940629547);

            // Expected jsonsize
            t.equal(coastline.jsonsize, 520120);

            t.end();
        });
    });
});

