var test = require('tape');
var tilelive = require('tilelive');
var url = require('url');
var Backend = require('..').Backend;
var mapnik = require('..').mapnik;
var path = require('path');
var fs = require('fs');
var Testsource = require('./testsource');
var UPDATE = process.env.UPDATE;

// Tilelive test source.
tilelive.protocols['test:'] = Testsource;

    test('invalid', function(t) {
        new Backend({}, function(err) {
            t.equal('Error: opts.uri or opts.source must be set', err.toString());
            t.end();
        });
    });
    test('async default opts', function(t) {
        new Backend({ uri:'test:///a' }, function(err, source) {
            t.ifError(err);
            t.equal(1, source._scale);
            t.equal(0, source._minzoom);
            t.equal(1, source._maxzoom);
            t.equal(undefined, source._fillzoom);
            t.end();
        });
    });
    test('sync default opts', function(t) {
        var source = new Backend({ source: new Testsource('a') });
        t.equal(1, source._scale);
        t.equal(0, source._minzoom);
        t.equal(22, source._maxzoom);
        t.equal(undefined, source._fillzoom);

        source = new Backend({
            source: new Testsource('a'),
            minzoom: 2,
            maxzoom: 22,
            fillzoom: 4
        });
        t.equal(1, source._scale);
        t.equal(2, source._minzoom);
        t.equal(22, source._maxzoom);
        t.equal(4, source._fillzoom);
        t.end();
    });
    test('proxies getInfo', function(t) {
        var source = new Testsource('a');
        var wrapped = new Backend({
            source: source,
            minzoom: 0,
            maxzoom: 1
        });
        source.getInfo(function(err, a) {
            t.ifError(err);
            wrapped.getInfo(function(err, b) {
                t.ifError(err);
                t.deepEqual(a, b);
                t.end();
            });
        });
    });

    var sources = {
        a: new Backend({ source: new Testsource('a'), minzoom:0, maxzoom: 1 }),
        b: new Backend({ source: new Testsource('b'), minzoom:0, maxzoom: 2, fillzoom: 1 }),
        c: new Backend({ source: new Testsource('b'), minzoom:0, maxzoom: 2, fillzoom: 1, scale: 2, legacy: true }),
        h: new Backend({ source: new Testsource('b'), minzoom:0, maxzoom: 2, fillzoom: 1, scale: 2 }),
        i: new Backend({ source: new Testsource('i'), minzoom:0, maxzoom: 1 }),
        iv: new Backend({ source: new Testsource('i'), minzoom:0, maxzoom: 1, vector_layers: [{id:'custom_layer_name'}] }),
        gz: new Backend({ source: new Testsource('gz'), minzoom:0, maxzoom: 0 }),
    };
    sources.d = new Backend({ source: sources.a, minzoom:0, maxzoom:1 });
    var tests = {
        // 2.0.0, 2.0.1 test overzooming.
        // 1.1.2, 1.1.3 test that solid bg tiles are generated even when no
        // backend tile exists.
        // 0.0.1 test that solid bg tiles are generated for 0-length protobufs.
        a: ['0.0.0', '0.0.1', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '1.1.2', '1.1.3', '2.0.0', '2.0.1'],
        // 2.1.1 should use z2 vector tile -- a coastline shapefile
        // 2.1.2 should use fillzoom -- place dots, like the others
        b: ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '2.1.1', '2.1.2'],
        // test the a legacy flag overriding the scale factor of the request affecting the output tile size
        c: ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '2.1.1', '2.1.2', '3.2.2', '3.2.3', '3.2.4'],
        // proxies through vector tiles (rather than PBFs) from a source.
        d: ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '1.1.2', '1.1.3', '2.0.0', '2.0.1'],
        // test the scale factor of the request affecting the output tile size
        h: ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '2.1.1', '2.1.2', '3.2.2', '3.2.3', '3.2.4'],
        // wraps image source with vector tiles.
        i: ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '1.1.1', '2.0.0', '2.0.1'],
        // wraps image source with vector tiles, with named vector layer.
        iv: ['0.0.0'],
        // loads gzip compressed protobuf.
        gz: ['0.0.0'],
    };
    Object.keys(tests).forEach(function(source) {
        tests[source].forEach(function(key) {
            var z = key.split('.')[0] | 0;
            var x = key.split('.')[1] | 0;
            var y = key.split('.')[2] | 0;
            var remaining = 2;
            test('should render ' + source + ' (' + key + ')', function(t) {
                var cbTile = function(err, vtile, headers) {
                    t.ifError(err);
                    // Returns a vector tile.
                    t.ok(vtile instanceof mapnik.VectorTile);
                    // No backend tiles last modified defaults to Date 0.
                    // Otherwise, Last-Modified from backend should be passed.
                    if (['1.1.2','1.1.3'].indexOf(key) >= 0 || (source == 'i' && ['2.0.0','2.0.1'].indexOf(key) >= 0)) {
                        t.equal(headers['Last-Modified'], new Date(0).toUTCString());
                        t.equal(headers['x-vector-backend-object'], 'empty', 'backend-object=empty');
                    } else {
                        t.equal(headers['Last-Modified'], Testsource.now.toUTCString());
                        t.equal(headers['x-vector-backend-object'], 'default', 'backend-object=default');
                    }
                    // Check for presence of ETag and store away for later
                    // ETag comparison.
                    t.ok('ETag' in headers);
                    // Content-Type.
                    t.equal(headers['Content-Type'], 'application/x-protobuf');
                    // Size stats attached to buffer.
                    t.equal('number', typeof vtile._srcbytes);
                    // Compare vtile contents to expected fixtures.
                    // if source is c, test legacy scale factor
                    // at zoom > 1 it will compare with data at previous zoom level.
                    if (source === 'c') {
                        if (key[0] > 1) {
                            key[0] -= 1;
                            var fixtpath = __dirname + '/expected/backend-' + source + '.' + key + '.json';
                            if (UPDATE) fs.writeFileSync(fixtpath, JSON.stringify(vtile.toJSON(), replacer, 2));
                            t.deepEqual(
                                JSON.parse(JSON.stringify(vtile.toJSON(), replacer)),
                                JSON.parse(fs.readFileSync(fixtpath))
                            );
                        }
                    } else {
                        var fixtpath = __dirname + '/expected/backend-' + source + '.' + key + '.json';
                        if (UPDATE) fs.writeFileSync(fixtpath, JSON.stringify(vtile.toJSON(), replacer, 2));
                        t.deepEqual(
                            JSON.parse(JSON.stringify(vtile.toJSON(), replacer)),
                            JSON.parse(fs.readFileSync(fixtpath))
                        );
                    }
                    t.end();
                };
                if (source === 'c') {
                    cbTile.legacy = true;
                }
                sources[source].getTile(z,x,y, cbTile);
            });
        });
    });
    test('treats unknown buffer as image', function(t) {
        sources.a.getTile(1, 0, 2, function(err, vtile) {
            t.ifError(err);
            t.deepEqual(vtile.toJSON()[0].name, '_image');
            t.end();
        });
    });
    test('errors out on bad protobuf', function(t) {
        sources.a.getTile(1, 0, 3, function(err, vtile) {
            t.ifError(err);
            vtile.parse(function(err) {
                t.equal('could not parse buffer as protobuf', err.message);
                t.end();
            });
        });
    });
    test('close is called on source', function(t) {
        var testsource = new Testsource('a');
        new Backend({ source:testsource }, function(err, backend) {
            backend.close(function(err) {
                t.equal(testsource.closeCalled, true);
                t.end();
            });
        });
    });

function replacer(key, value) {
    if (key === 'raster') {
        if ("data" in value)
        {
            value = value.data;
        }
        var ln = value.length || 0;
        var buffer = new Buffer(ln);
        for (var i = 0; i < ln; i++) buffer.writeUInt8(value[i], i);
        return buffer.toString('hex');
    } else {
        return value;
    }
}
