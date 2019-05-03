const test = require('tape');
const tilelive = require('@mapbox/tilelive');
const TileJSON = require('@mapbox/tilejson');
const url = require('url');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Vector = require('..');

function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

// skip tests that require s3 authentication if necessary
// use ~$ TILELIVE_VECTOR_NO_AUTH=true npm test
const TILELIVE_VECTOR_NO_AUTH = (process.env.TILELIVE_VECTOR_NO_AUTH) ? process.env.TILELIVE_VECTOR_NO_AUTH : false;

// Load fixture data.
const fixtureDir = path.resolve(__dirname, 'fixtures', 'tm2z'),
    remotePath = 'http://mapbox.s3.amazonaws.com/tilelive-vector/test-tm2z.tm2z',
    xml = fs.readFileSync(path.join(fixtureDir, 'project', 'project.xml'), 'utf8');

// Register vector:, tm2z:, tm2z+http: and mapbox: tilelive protocols
Vector.registerProtocols(tilelive);
tilelive.protocols['mapbox:'] = function Source(uri, callback) {
    const MapboxAccessToken = process.env.MapboxAccessToken;
    if (!MapboxAccessToken) return callback(new Error('env var MapboxAccessToken is required'));
    return new TileJSON('http://a.tiles.mapbox.com/v4' + uri.pathname + '.json?access_token=' + MapboxAccessToken, callback);
};

// Register font
Vector.mapnik.register_fonts(path.join(__dirname, 'fonts', 'source-sans-pro'));

['cold', 'warm'].forEach((label) => {
    test(label + ': tm2z+http content length error', (assert) => {
        const server = require('http').createServer((req, res) => {
            const buffer = fs.readFileSync(path.join(fixtureDir, 'patternstyle.tm2z'));
            res.setHeader('content-length', buffer.length);
            res.writeHead(200);
            res.write(buffer.slice(0,250e3));
            req.socket.destroy();
        });
        server.listen(9191, afterListen);
        function afterListen(err) {
            assert.ifError(err);
            tilelive.load('tm2z+http://127.0.0.1:9191/patternstyle.tm2z', (err, source) => {
                assert.ok(err, 'has error');
                assert.equal(err.code, undefined, 'not a mapnik error');
                server.close(afterClose);
            });
        }
        function afterClose(err) {
            assert.ifError(err);
            assert.end();
        }
    });
});

test('tm2z+http ENOTFOUND or Z_DATA_ERROR', (assert) => {
    tilelive.load('tm2z+http://not-a-valid-domain/patternstyle.tm2z', (err, source) => {
        assert.ok(err, 'has error');
        if (err.code && err.code === 'Z_DATA_ERROR') {
            assert.equal(err.code, 'Z_DATA_ERROR', 'code: Z_DATA_ERROR');
        } else {
            assert.equal(err.code, 'ENOTFOUND', 'code: ENOTFOUND');
        }
        assert.end();
    });
});

test('exposes the mapnik binding', (t) => {
    t.ok(Vector.mapnik);
    t.end();
});
test('direct load (string uri)', (t) => {
    Vector.tm2z('tm2z://' + path.join(fixtureDir, 'project.tm2z'), (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('direct load (object uri)', (t) => {
    Vector.tm2z({ protocol:'tm2z:', pathname: path.join(fixtureDir, 'project.tm2z') }, (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('loads a tm2z url', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project.tm2z'), (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('loads a tm2z url once', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'doublecall.tm2z'), (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('matches expected xml', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project.tm2z'), (err, source) => {
        t.ifError(err);
        t.equal(source._xml, xml);
        t.end();
    });
});
test('gunzips then untars', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project.tar.gz'), (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('errors out if not gzipped', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project.tar'), (err, source) => {
        t.equal(err.code, 'Z_DATA_ERROR');
        t.equal(err.message, 'incorrect header check');
        t.end();
    });
});
test('errors out on bad gunzip', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'doublezip.tm2z'), (err, source) => {
        t.equal(err.message, 'invalid tar file');
        t.end();
    });
});
test('errors out if file size exceeds max size', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'filesize.tm2z'), (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Upload size should not exceed 750KB.');
        t.end();
    });
});
test('errors out if file size exceeds custom max size', (t) => {
    tilelive.load({
        protocol: 'tm2z:',
        pathname: path.join(fixtureDir, 'filesize.tm2z'),
        filesize: 500 * 1024
    }, (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Upload size should not exceed 500KB.');
        t.end();
    });
});
test('errors out if unzipped size exceeds max size', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'gunzipsize.tm2z'), (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Unzipped size should not exceed 5MB.');
        t.end();
    });
});
test('errors out if unzipped size exceeds custom max size', (t) => {
    tilelive.load({
        protocol: 'tm2z:',
        pathname: path.join(fixtureDir, 'gunzipsize.tm2z'),
        gunzipsize: 1024 * 1024
    }, (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Unzipped size should not exceed 1MB.');
        t.end();
    });
});
test('errors out if unzipped project.xml size exceeds max size', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'xmlsize.tm2z'), (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Unzipped project.xml size should not exceed 750KB.');
        t.end();
    });
});
test('errors out if unzipped project.xml size exceeds custom max size', (t) => {
    tilelive.load({
        protocol: 'tm2z:',
        pathname: path.join(fixtureDir, 'xmlsize.tm2z'),
        xmlsize: 300 * 1024
    }, (err, source) => {
        t.equal(err instanceof RangeError, true);
        t.equal(err.message, 'Unzipped project.xml size should not exceed 300KB.');
        t.end();
    });
});
test('errors out if not a directory', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'nodirectory.tm2z'), (err, source) => {
        t.ok(err.message.indexOf('EISDIR') !== -1);
        t.end();
    });
});
test('errors out if missing project.xml', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'empty.tm2z'), (err, source) => {
        t.equal(err.message, 'project.xml not found in package');
        t.end();
    });
});
test('errors out on invalid project.xml', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'malformed.tm2z'), (err, source) => {
        t.equal('EMAPNIK', err.code);
        // err.message on windows is completely different
        // assert(err.message.split(':')[0], 'expected < at line 1');
        t.end();
    });
});
test('errors out if style references a missing font', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'missing_font.tm2z'), (err, source) => {
        t.equal('EMAPNIK', err.code);
        t.equal(err.message.split("'")[0], 'Failed to find font face ');
        t.end();
    });
});
test('does not error out if style references a registered font', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project.tm2z'), (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('errors out if style references a missing image', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'missing_image.tm2z'), (err, source) => {
        t.equal('EMAPNIK', err.code);
        t.equal(err.message.split(':')[0], 'file could not be found');
        t.end();
    });
});
test('errors out if style causes parse error', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'invalid_parsecolor.tm2z'), (err, source) => {
        source.getTile(3, 4, 3, (err, run1, headers) => {
            t.equal('EMAPNIK', err.code);
            t.equal(err.message.split(':')[0], 'Failed to parse color');
            t.end();
        });
    });
});
test('profiles a tm2z file', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'project-v6.tm2z'), (err, source) => {
        t.ifError(err);
        source.profile((err, profile) => {
            t.ifError(err);
            t.deepEqual([
                'tiles',
                'xmltime',
                'drawtime',
                'loadtime',
                'srcbytes',
                'imgbytes'
            ], Object.keys(profile));
            t.equal('number', typeof profile.xmltime);
            t.deepEqual(['avg','min','max'], Object.keys(profile.drawtime));
            t.deepEqual(['avg','min','max'], Object.keys(profile.loadtime));
            t.deepEqual(['avg','min','max'], Object.keys(profile.srcbytes));
            t.deepEqual(['avg','min','max'], Object.keys(profile.imgbytes));
            const expected_tiles = ['0/0/0', '1/1/0', '2/2/1', '3/4/3', '4/9/6', '5/19/12', '6/39/24', '7/79/48', '8/159/96', '9/319/193', '10/638/387', '11/1276/774', '12/2553/1548', '13/5107/3096', '14/10214/6192', '15/20429/12384', '16/40859/24769', '17/81718/49538', '18/163437/99077', '19/326874/198154', '20/653749/396308', '21/1307499/792616', '22/2614998/1585232'];
            const actual_tiles = profile.tiles.map((t) => { return t.z + '/' + t.x + '/' + t.y; });
            // Note: due to frequent data instability in upstream data
            // we only test the # of tiles now and not the exact z/x/y
            //  https://github.com/mapbox/tilelive-vector/pull/134
            //  https://github.com/mapbox/tilelive-vector/pull/128
            //  https://github.com/mapbox/tilelive-vector/commit/87d7d7a30cbbdb01f57aaa993b6907c944bb9ec2
            t.deepEqual(actual_tiles.length,expected_tiles.length);
            t.end();
        });
    });
});
test('profiles tm2z with very southern data', (t) => {
    tilelive.load('tm2z://' + path.join(fixtureDir, 'invalid.tm2z'), (err, source) => {
        t.ifError(err);
        source.profile((err, profile) => {
            t.ifError(err);
            t.deepEqual([
                'tiles',
                'xmltime',
                'drawtime',
                'loadtime',
                'srcbytes',
                'imgbytes'
            ], Object.keys(profile), 'produced correct fields of profile');
            t.end();
        });
    });
});

test('loads a tm2z+http url', (t) => {
    tilelive.load('tm2z+' + remotePath, (err, source) => {
        t.ifError(err);
        t.end();
    });
});
test('matches expected xml', (t) => {
    tilelive.load('tm2z+' + remotePath, (err, source) => {
        t.ifError(err);
        t.equal(xml, source._xml);
        t.end();
    });
});
test('errors out on an invalid S3 url', (t) => {
    tilelive.load('tm2z+http://mapbox.s3.amazonaws.com/tilelive-vector/invalid.tm2z', (err, source) => {
        t.equal('Z_DATA_ERROR', err.code);
        t.end();
    });
});

test('errors out on private object with tm2z+http protocol', { skip: TILELIVE_VECTOR_NO_AUTH }, (t) => {
    tilelive.load('tm2z+http://mapbox.s3.amazonaws.com/tilelive-vector/test-tm2z-private.tm2z', (err, source) => {
        t.equal('Z_DATA_ERROR', err.code);
        t.end();
    });
});

test('load private tm2z from s3 using tm2z+s3 protocol', { skip: TILELIVE_VECTOR_NO_AUTH }, (t) => {
    tilelive.load('tm2z+s3://mapbox/tilelive-vector/test-tm2z-private.tm2z', (err, source) => {
        t.ifError(err);
        t.end();
    });
});

test('errors out on tm2z file on s3 where we do not have access', { skip: TILELIVE_VECTOR_NO_AUTH }, (t) => {
    tilelive.load('tm2z+s3://example/does-not-exist.tm2z', (err, source) => {
        t.equal(err.code, 'AccessDenied');
        t.end();
    });
});
