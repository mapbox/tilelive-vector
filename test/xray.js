const test = require('tape');
const tilelive = require('@mapbox/tilelive');
const imageEqualsFile = require('./image.js');
const Testsource = require('./testsource');
const xray = require('..').xray;
const fs = require('fs');
const UPDATE = process.env.UPDATE;
const path = require('path');

// Tilelive test source.
tilelive.protocols['test:'] = Testsource;

test('invalid', (t) => {
    new xray({}, (err) => {
        t.equal('Error: opts.uri or opts.source must be set', err.toString());
        t.end();
    });
});
test('invalid-novector', (t) => {
    new xray({ uri:'test:///invalid-novector' }, (err) => {
        t.equal('Error: source must contain a vector_layers property', err.toString());
        t.end();
    });
});
test('loads uri', (t) => {
    new xray({ uri:'test:///a' }, (err, source) => {
        t.ifError(err);
        t.ok(!!source);
        source.getTile(0,0,0, (err,buffer) => {
            t.ifError(err);
            if (UPDATE) {
                fs.writeFileSync(path.join(__dirname, 'expected', 'xray-a-0-0-0.png'), buffer);
            }
            imageEqualsFile(buffer, path.join(__dirname, 'expected', 'xray-a-0-0-0.png'), (err) => {
                t.ifError(err);
                t.end();
            });
        });
    });
});
test('loads uri + transparent', (t) => {
    new xray({ uri:'test:///a', transparent:true }, (err, source) => {
        t.ifError(err);
        t.ok(!!source);
        source.getTile(0,0,0, (err,buffer) => {
            t.ifError(err);
            if (UPDATE) {
                fs.writeFileSync(path.join(__dirname, 'expected', 'xray-a-0-0-0-transparent.png'), buffer);
            }
            imageEqualsFile(buffer, path.join(__dirname, 'expected', 'xray-a-0-0-0-transparent.png'), (err) => {
                t.ifError(err);
                t.end();
            });
        });
    });
});
test('loads source', (t) => {
    const source = new Testsource('a');
    new xray({
        source: source,
        minzoom: 0,
        maxzoom: 1,
        vector_layers: [{ id:'coastline' }]
    }, (err, source) => {
        t.ifError(err);
        t.ok(!!source);
        t.end();
    });
});
test('loads raster source', (t) => {
    new xray({ uri:'test:///i' }, (err, source) => {
        t.ifError(err);
        t.ok(!!source);
        source.getTile(0,0,0, (err,buffer) => {
            t.ifError(err);
            if (UPDATE) {
                fs.writeFileSync(__dirname + '/expected/xray-i-0-0-0.png', buffer);
            }
            imageEqualsFile(buffer, __dirname + '/expected/xray-i-0-0-0.png', (err) => {
                t.ifError(err);
                t.end();
            });
        });
    });
});
test('color', (t) => {
    const results = {
        '': [68,68,68],
        'a': [68,170,68],
        'ab': [68,170,85],
        'world': [136,221,102],
        'rivers and lakes': [170,153,85]
    };
    for (const key in results) {
        t.deepEqual(xray.color(key), results[key]);
    }
    t.end();
});
test('xml', (t) => {
    const results = {
        'xray-single.xml': xray.xml({
            map_properties: 'background-color="#000000"',
            vector_layers: [
                { 'id': 'coastline' }
            ]
        }),
        'xray-multi.xml': xray.xml({
            map_properties: 'background-color="#000000"',
            vector_layers: [
                { 'id': 'coastline' },
                { 'id': 'countries' },
                { 'id': 'water' },
                { 'id': 'landuse' }
            ]
        })
    };
    for (const key in results) {
        if (UPDATE) {
            fs.writeFileSync(path.join(__dirname, 'expected', key), results[key]);
        }
        const expected = fs.readFileSync(path.join(__dirname, 'expected', key), 'utf8');
        t.equal(expected, results[key]);
    }
    t.end();
});
