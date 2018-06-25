var tilelive = require('@mapbox/tilelive');
var crypto = require('crypto');
var mapnik = require('mapnik');
var util = require('util');
var sm = new (require('@mapbox/sphericalmercator'))();

module.exports = Backend;

function Backend(opts, callback) {
    this._layer = opts.layer || undefined;
    this._scale = opts.scale || 1;
    this._source = null;
    var backend = this;
    if (opts.source) {
        setsource(opts.source, opts);
    } else if (opts.uri) {
        tilelive.load(opts.uri, function(err, source) {
            if (err) return callback(err);
            source.getInfo(function(err, info) {
                if (err) return callback(err);
                setsource(source, info);
            });
        });
    } else {
        if (callback) callback(new Error('opts.uri or opts.source must be set'));
    }

    function setsource(source, info) {
        backend._minzoom = typeof info.minzoom === 'number' ? info.minzoom : 0;
        backend._maxzoom = typeof info.maxzoom === 'number' ? info.maxzoom : 22;
        backend._vector_layers = info.vector_layers || undefined;
        backend._layer = backend._layer ||
            (info.vector_layers && info.vector_layers.length && info.vector_layers[0].id) ||
            '_image';
        backend._fillzoom = 'fillzoom' in info && !isNaN(parseInt(info.fillzoom, 10)) ?
            parseInt(info.fillzoom, 10) :
            undefined;
        backend._source = source;
        if (callback) callback(null, backend);
    }
};

Backend.prototype.getInfo = function(callback) {
    if (!this._source) return callback(new Error('Tilesource not loaded'));
    this._source.getInfo(callback);
};

Backend.prototype.getTile = function(z, x, y, callback) {
    if (!this._source) return callback(new Error('Tilesource not loaded'));
    if (z < 0 || x < 0 || y < 0 || x >= Math.pow(2,z) || y >= Math.pow(2,z)) {
        return callback(new Error('Tile does not exist'));
    }
    var backend = this;
    var source = backend._source;
    var now = +new Date;
    // if true, return raw buffer rather than mapnik.VectorTile
    var raw_buffer = callback.raw_buffer || false;
    var legacy = callback.legacy || false;
    var scale = callback.scale || backend._scale;
    var upgrade = callback.upgrade || false;

    // If scale > 1 adjusts source data zoom level inversely.
    // scale 2x => z-1, scale 4x => z-2, scale 8x => z-3, etc.
    if (legacy && z >= backend._minzoom) {
        var d = Math.round(Math.log(scale)/Math.log(2));
        var bz = (z - d) > backend._minzoom ? z - d : backend._minzoom;
        var bx = Math.floor(x / Math.pow(2, z - bz));
        var by = Math.floor(y / Math.pow(2, z - bz));
    } else {
        var bz = z | 0;
        var bx = x | 0;
        var by = y | 0;
    }

    var size = 0;
    var headers = {};

    // Overzooming support.
    if (bz > backend._maxzoom) {
        bz = backend._maxzoom;
        bx = Math.floor(x / Math.pow(2, z - bz));
        by = Math.floor(y / Math.pow(2, z - bz));
        headers['x-vector-backend-object'] = 'overzoom';
    }

    function makevtile(data, type) {
        // If no last modified is provided, use epoch.
        headers['Last-Modified'] = new Date(headers['Last-Modified'] || 0).toUTCString();

        // Set an ETag if not present.
        headers['ETag'] = headers['ETag'] || JSON.stringify(crypto.createHash('md5')
            .update((z+','+x+','+y) + (data||''))
            .digest('hex'));

        // Set content type.
        headers['Content-Type'] = 'application/x-protobuf';

        // Set x-vector-backend-status header.
        headers['x-vector-backend-object'] = headers['x-vector-backend-object'] || 'default';

        // Pass-thru of raw buffer (no mapnik.VectorTile)
        if (raw_buffer) {
            if (data) {
              data.tile_type = type;
              data.layer_name = backend._layer;
            }
            return callback(null, data, headers, bz, bx, by);
        }

        // Pass-thru of an upstream mapnik vector tile (not pbf) source.
        if (data instanceof mapnik.VectorTile) return callback(null, data, headers);

        var vtile = new mapnik.VectorTile(bz, bx, by);
        vtile._srcbytes = size;
        if (callback.setSrcData) vtile._srcdata = data;

        // null/zero length data is a solid tile be painted.
        if (!data || !data.length) return callback(null, vtile, headers);

        try {
            if (type === 'pbf') {
                // We use addData here over setData because we know it was just created
                // and is empty so skips a clear call internally in mapnik.
                vtile.addData(data,{upgrade:upgrade},function(err) {
                    if (err) return callback(err);
                    return callback(null, vtile, headers);
                });
            } else {
                vtile.addImageBuffer(data, backend._layer, function(err) {
                    if (err) return callback(err);
                    return callback(null, vtile, headers);
                });
            }
        } catch (err) {
            return callback(err);
        }
    };

    function sourceGet(err, body, head) {
        if (typeof backend._fillzoom === 'number' &&
            err && err.message === 'Tile does not exist' &&
            bz > backend._fillzoom) {
            bz = backend._fillzoom;
            bx = Math.floor(x / Math.pow(2, z - bz));
            by = Math.floor(y / Math.pow(2, z - bz));
            headers['x-vector-backend-object'] = 'fillzoom';
            return source.getTile(bz, bx, by, sourceGet);
        }
        if (err && err.message !== 'Tile does not exist') return callback(err);

        if (body instanceof mapnik.VectorTile) {
            size = body._srcbytes;
            headers = head || {};
            return makevtile(body);
        }

        var compression = false;
        if (body && body[0] == 0x78 && body[1] == 0x9C) {
            compression = 'inflate';
        } else if (body && body[0] == 0x1F && body[1] == 0x8B) {
            compression = 'gunzip';
        }

        if (!body || !body.length) {
            headers['x-vector-backend-object'] = 'empty';
            return makevtile();
        } else if (compression) {
            size = body.length;
            headers = head || {};
            return makevtile(body, 'pbf');
        // Image sources do not allow overzooming (yet).
        } else if (bz < z && headers['x-vector-backend-object'] !== 'fillzoom') {
            headers['x-vector-backend-object'] = 'empty';
            return makevtile();
        } else {
            size = body.length;
            headers = head || {};
            return makevtile(body);
        }
    };

    sourceGet.scale = scale;
    sourceGet.legacy = legacy;
    sourceGet.upgrade = upgrade;
    source.getTile(bz, bx, by, sourceGet);

};

// Proxies mapnik vtile.query method with the added convienice of
// letting the tilelive-vector backend do the hard work of finding
// the right tile to use.
Backend.prototype.queryTile = function(z, lon, lat, options, callback) {
    var xyz = sm.xyz([lon, lat, lon, lat], z);
    this.getTile(z, xyz.minX, xyz.minY, function(err, vtile, head) {
        if (err) return callback(err);
        vtile.query(lon, lat, options, function(err, features) {
            if (err) return callback(err);
            var results = [];
            for (var i = 0; i < features.length; i++) {
                results.push({
                    id: features[i].id(),
                    distance: features[i].distance,
                    layer: features[i].layer,
                    attributes: features[i].attributes(),
                    geometry: {
                        type: 'Point',
                        coordinates: features[i].x_hit ?
                            [ features[i].x_hit, features[i].y_hit ] :
                            [ lon, lat ]
                    }
                });
            }
            var headers = {};
            headers['Content-Type'] = 'application/json';
            headers['ETag'] = JSON.stringify(crypto.createHash('md5')
                .update(head && head['ETag'] || (z+','+lon+','+lat))
                .digest('hex'));
            headers['Last-Modified'] = new Date(head && head['Last-Modified'] || 0).toUTCString();
            return callback(null, results, headers);
        });
    });
};
