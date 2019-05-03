'use strict';

const tilelive = require('@mapbox/tilelive');
const tiletype = require('@mapbox/tiletype');
const mapnik = require('mapnik');
const fs = require('fs');
const tar = require('tar');
const url = require('url');
const qs = require('querystring');
const zlib = require('zlib');
const path = require('path');
const os = require('os');
const util = require('util');
const crypto = require('crypto');
const request = require('request');
const exists = fs.exists || require('path').exists;
const numeral = require('numeral');
const sm = new (require('@mapbox/sphericalmercator'))();
const profiler = require('./tile-profiler');
const Backend = require('./backend');
const AWS = require('aws-sdk');
const s3urls = require('s3urls');
const { EventEmitter } = require('events');

// Register fonts for xray styles.
mapnik.register_fonts(path.resolve(__dirname, 'fonts'));

function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

class Vector extends EventEmitter {
    constructor(uri, callback) {
        super();

        if (typeof uri === 'string' || (uri.protocol && !uri.xml)) {
            uri = typeof uri === 'string' ? url.parse(uri) : uri;
            const filepath = path.resolve(uri.pathname);
            fs.readFile(filepath, 'utf8', (err, xml) => {
                if (err) return callback(err);
                Vector({
                    xml:xml,
                    base:path.dirname(filepath)
                }, callback);
            });
            return;
        }

        if (!uri.xml) return callback && callback(new Error('No xml'));

        this._uri = uri;
        this._scale = uri.scale || undefined;
        this._format = uri.format || undefined;
        this._renderer = uri.renderer || undefined;
        this._source = uri.source || undefined;
        this._backend = uri.backend || undefined;
        this._base = path.resolve(uri.base || __dirname);

        if (callback) this.once('open', callback);

        const s = this;
        this.update(uri, (err) => { s.emit('open', err, s); });
    }

    static registerProtocols() {
        tilelive.protocols['vector:'] = Vector;
        tilelive.protocols['tm2z:'] = tm2z;
        tilelive.protocols['tm2z+http:'] = tm2z;
        tilelive.protocols['tm2z+s3:'] = tm2z;
    }

    /**
     * Helper for callers to ensure source is open. This is not built directly
     * into the constructor because there is no good auto cache-keying system
     * for these tile sources (ie. sharing/caching is best left to the caller).
     */
    open(callback) {
        if (this._map) return callback(null, this);
        this.once('open', callback);
    }

    close(callback) {
        return callback();
    }

    /*
     * Allows in-place update of XML/backends.
     */
    update(opts, callback) {
        const s = this;
        const map = new mapnik.Map(256,256);
        map.fromString(opts.xml, {
            strict: module.exports.strict,
            base: this._base + path.sep
        }, (err) => {
            if (err) {
                err.code = 'EMAPNIK';
                return callback(err);
            }

            delete s._info;
            s._xml = opts.xml;
            s._map = map;
            s._md5 = crypto.createHash('md5').update(opts.xml).digest('hex');
            s._format = opts.format || map.parameters.format || s._format || 'png8:m=h';
            s._scale = opts.scale || +map.parameters.scale || s._scale || 1;

            const source = map.parameters.source || opts.source;
            if (!s._backend || s._source !== source) {
                if (!source) return callback(new Error('No backend'));
                new Backend({
                    uri: source,
                    scale: s._scale
                }, (err, backend) => {
                    if (err) return callback(err);
                    s._source = map.parameters.source || opts.source;
                    s._backend = backend;
                    return callback();
                });
            } else {
                return callback();
            }
        });
        return;
    }

    getTile(z, x, y, callback) {
        if (!this._map) return callback(new Error('Tilesource not loaded'));
        if (z < 0 || x < 0 || y < 0 || x >= Math.pow(2,z) || y >= Math.pow(2,z)) {
            return callback(new Error('Tile does not exist'));
        }
        // Hack around tilelive API - allow params to be passed per request
        // as attributes of the callback function.
        let format = callback.format || this._format;
        const scale = callback.scale || this._scale;
        const profile = callback.profile || false;
        const legacy = callback.legacy || false;
        const upgrade = callback.upgrade || false;
        const width = !legacy ? scale * 256 | 0 || 256 : 256;
        const height = !legacy ? scale * 256 | 0 || 256 : 256;

        const source = this;
        let drawtime;
        let loadtime = +new Date;
        const cb = (err, vtile, head) => {
            if (err && err.message !== 'Tile does not exist')
                return callback(err);

            // For xray styles use srcdata tile format.
            if (!callback.format && source._xray && vtile._srcdata) {
                const type = tiletype.type(vtile._srcdata);
                format = type === 'jpg' ? 'jpeg' : type === 'webp' ? 'webp' : 'png8:m=h';
            }

            const headers = {};
            switch (format.match(/^[a-z]+/i)[0]) {
                case 'headers':
                    // No content type for header-only.
                    break;
                case 'json':
                case 'utf':
                    headers['Content-Type'] = 'application/json';
                    break;
                case 'jpeg':
                    headers['Content-Type'] = 'image/jpeg';
                    break;
                case 'svg':
                    headers['Content-Type'] = 'image/svg+xml';
                    break;
                case 'png':
                default:
                    headers['Content-Type'] = 'image/png';
                    break;
            }
            headers['ETag'] = JSON.stringify(crypto.createHash('md5')
                .update(scale + source._md5 + (head && head['ETag'] || (z + ',' + x + ',' + y)))
                .digest('hex'));
            headers['Last-Modified'] = new Date(head && head['Last-Modified'] || 0).toUTCString();

            // Passthrough backend expires header if present.
            if (head['Expires'] || head['expires']) headers['Expires'] = head['Expires'] || head['expires'];

            // Passthrough backend object headers.
            headers['x-vector-backend-object'] = head['x-vector-backend-object'];

            // Return headers for 'headers' format.
            if (format === 'headers') return callback(null, headers, headers);

            loadtime = (+new Date) - loadtime;
            drawtime = +new Date;
            const opts = { z:z, x:x, y:y, scale:scale, buffer_size:256 * scale };

            let surface;
            if (format === 'json') {
                try { return callback(null, vtile.toJSON(), headers); }
                catch (err) { return callback(err); }
            } else if (format === 'utf') {
                surface = new mapnik.Grid(width,height);
                opts.layer = source._map.parameters.interactivity_layer;
                opts.fields = source._map.parameters.interactivity_fields.split(',');
            } else if (format === 'svg') {
                surface = new mapnik.CairoSurface('svg',width,height);
                if (callback.renderer || this._renderer) {
                    opts.renderer = callback.renderer || this._renderer;
                }
            } else {
                surface = new mapnik.Image(width,height);
            }
            vtile.render(source._map, surface, opts, (err, image) => {
                if (err) {
                    err.code = 'EMAPNIK';
                    return callback(err);
                }
                if (format === 'svg') {
                    headers['Content-Type'] = 'image/svg+xml';
                    return callback(null, image.getData(), headers);
                } else if (format === 'utf') {
                    image.encode({}, (err, buffer) => {
                        if (err) return callback(err);
                        return callback(null, buffer, headers);
                    });
                } else {
                    image.encode(format, {}, (err, buffer) => {
                        if (err) return callback(err);

                        buffer._loadtime = loadtime;
                        buffer._drawtime = (+new Date) - drawtime;
                        buffer._srcbytes = vtile._srcbytes || 0;

                        if (profile) buffer._layerInfo = profiler.layerInfo(vtile);

                        return callback(null, buffer, headers);
                    });
                }
            });
        };
        if (!callback.format && source._xray) {
            cb.setSrcData = true;
        }
        cb.format = format;
        cb.scale = scale;
        cb.legacy = legacy;
        cb.upgrade = upgrade;
        source._backend.getTile(z, x, y, cb);
    }

    getGrid(z, x, y, callback) {
        if (!this._map) return callback(new Error('Tilesource not loaded'));
        if (!this._map.parameters.interactivity_layer) return callback(new Error('Tilesource has no interactivity_layer'));
        if (!this._map.parameters.interactivity_fields) return callback(new Error('Tilesource has no interactivity_fields'));
        callback.format = 'utf';
        return this.getTile(z, x, y, callback);
    }

    getHeaders(z, x, y, callback) {
        callback.format = 'headers';
        return this.getTile(z, x, y, callback);
    }

    getInfo(callback) {
        if (!this._map) return callback(new Error('Tilesource not loaded'));
        if (this._info) return callback(null, this._info);

        const params = this._map.parameters;
        this._info = Object.keys(params).reduce((memo, key) => {
            switch (key) {
                // The special "json" key/value pair allows JSON to be serialized
                // and merged into the metadata of a mapnik XML based source. This
                // enables nested properties and non-string datatypes to be
                // captured by mapnik XML.
                case 'json':
                    try {
                        const jsondata = JSON.parse(params[key]);

                        Object.keys(jsondata).reduce((memo, key) => {
                            memo[key] = memo[key] || jsondata[key];
                            return memo;
                        }, memo);
                    } catch (err) {
                        return callback(err);
                    }

                    break;
                case 'bounds':
                case 'center':
                    memo[key] = params[key].split(',').map((v) => { return parseFloat(v); });
                    break;
                case 'scale':
                    memo[key] = params[key].toString();
                    break;
                default:
                    memo[key] = params[key];
                    break;
            }
            return memo;
        }, {}
        );

        return callback(null, this._info);
    }

    /*
     * Proxies mapnik vtile.query method with the added convienice of
     * letting the tilelive-vector backend do the hard work of finding
     * the right tile to use.
     */
    queryTile(z, lon, lat, options, callback) {
        this._backend.queryTile(z, lon, lat, options, callback);
    }

    profile(callback) {
        const s = this;
        const map = new mapnik.Map(256,256);
        let xmltime = Date.now();
        const densest = [];

        map.fromString(this._xml, {
            strict: module.exports.strict,
            base: this._base + '/'
        }, (err) => {
            if (err) {
                err.code = 'EMAPNIK';
                return callback(err);
            }

            xmltime = Date.now() - xmltime;

            s.getInfo((err, info) => {
                if (err) return callback(err);

                s._backend.getInfo((err, backend_info) => {
                    if (err) return callback(err);

                    const center = (info.center || backend_info.center).slice(0);
                    const minzoom = info.minzoom || backend_info.minzoom || 0;
                    const maxzoom = info.maxzoom || backend_info.maxzoom || 22;

                    // wrapx lon value.
                    center[0] = ((((center[0] + 180) % 360) + 360) % 360) - 180;

                    const xyz = sm.xyz([center[0], center[1], center[0], center[1]], minzoom);

                    getTiles(minzoom, xyz.minX, xyz.minY);

                    // Profile derivative four tiles of z,x,y
                    function getTiles(z, x, y) {
                        const tiles = [];
                        const queue = [{ z:z, x:x + 0, y:y + 0 }];
                        if (x + 1 < Math.pow(2,z)) queue.push({ z:z, x:x + 1, y:y + 0 });
                        if (y + 1 < Math.pow(2,z)) queue.push({ z:z, x:x + 0, y:y + 1 });
                        if (x + 1 < Math.pow(2,z) && y + 1 < Math.pow(2,z)) queue.push({ z:z, x:x + 1, y:y + 1 });
                        getTile();
                        function getTile() {
                            if (queue.length) {
                                const t = queue.shift();
                                s.getTile(t.z, t.x, t.y, (err, run1, headers) => {
                                    if (err) {
                                        err.code = 'EMAPNIK';
                                        return callback(err);
                                    }
                                    s.getTile(t.z, t.x, t.y, (err, run2, headers) => {
                                        if (err) return callback(err);
                                        t.drawtime = Math.min(run1._drawtime, run2._drawtime);
                                        t.loadtime = run1._loadtime;
                                        t.srcbytes = run1._srcbytes;
                                        t.imgbytes = run1.length;
                                        t.buffer = run1;
                                        tiles.push(t);
                                        getTile();
                                    });
                                });
                            } else {
                                tiles.sort((a, b) => {
                                    if (a.imgbytes < b.imgbytes) return 1;
                                    if (a.imgbytes > b.imgbytes) return -1;
                                    return 0;
                                });
                                densest.push(tiles[0]);

                                // Done.
                                if (z >= maxzoom) return callback(null, {
                                    tiles: densest,
                                    xmltime: xmltime,
                                    drawtime: densest.reduce(stat('drawtime', densest.length), {}),
                                    loadtime: densest.reduce(stat('loadtime', densest.length), {}),
                                    srcbytes: densest.reduce(stat('srcbytes', densest.length), {}),
                                    imgbytes: densest.reduce(stat('imgbytes', densest.length), {}),
                                });

                                /* eslint-disable no-inner-declarations */
                                function stat(key, count) { return (memo, t) => {
                                    memo.avg = (memo.avg || 0) + t[key] / count;
                                    memo.min = Math.min(memo.min || Infinity, t[key]);
                                    memo.max = Math.max(memo.max || 0, t[key]);
                                    return memo;
                                };}

                                // profiling zxy @ zoom level < center.
                                // next zxy should remain on center coords.
                                if (z < center[2]) {
                                    const xyz = sm.xyz([center[0], center[1], center[0], center[1]], z + 1);
                                    getTiles(z + 1, xyz.minX, xyz.minY);
                                // profiling zxy @ zoomlevel >= center.
                                // next zxy descend based on densest tile.
                                } else {
                                    getTiles(z + 1, tiles[0].x * 2, tiles[0].y * 2);
                                }
                            }
                        }
                    }
                });
            });
        });
    }
}

function tm2z(uri, callback) {
    if (typeof uri === 'string') {
        uri = url.parse(uri, true);
        uri.pathname = qs.unescape(uri.pathname);
    }

    const maxsize = {
        file: uri.filesize || 750 * 1024,
        gunzip: uri.gunzipsize || 5 * 1024 * 1024,
        xml: uri.xmlsize || 750 * 1024
    };

    const id = url.format(uri);

    let xml;
    const base = path.join(os.tmpDir(), md5(id).substr(0,8) + '-' + path.basename(id));
    const parser = new tar.Parse();
    const gunzip = zlib.Gunzip();
    let unpacked = false;

    let once = 0;
    const error = (err) => { if (!once++) callback(err); };

    // Check for unpacked manifest
    exists(base + '/.unpacked', (exists) => {
        unpacked = exists;
        if (unpacked) {
            unpack();
        } else {
            fs.mkdir(base, (err) => {
                if (err && err.code !== 'EEXIST') return callback(err);
                unpack();
            });
        }
    });

    function unpack() {
        let stream;
        const size = {
            file: 0,
            gunzip: 0,
            xml: 0
        };
        const todo = [];

        function chunked(chunk) {
            size.file += chunk.length;
            if (size.file > maxsize.file) {
                const err = new RangeError('Upload size should not exceed ' + numeral(maxsize.file).format('0b') + '.');
                stream.emit('error', err);
            }
        }

        gunzip.on('data', (chunk) => {
            size.gunzip += chunk.length;
            if (size.gunzip > maxsize.gunzip) {
                const err = new RangeError('Unzipped size should not exceed ' + numeral(maxsize.gunzip).format('0b') + '.');
                gunzip.emit('error', err);
            }
        });
        parser.on('entry', (entry) => {
            const parts = [];
            const filepath = entry.props.path.split('/').slice(1).join('/');
            entry.on('data', (chunk) => {
                if (path.basename(filepath).toLowerCase() === 'project.xml') {
                    size.xml += chunk.length;
                    if (size.xml > maxsize.xml) {
                        const err = new RangeError('Unzipped project.xml size should not exceed ' + numeral(maxsize.xml).format('0b') + '.');
                        parser.emit('error', err);
                    }
                }
                parts.push(chunk);
            });
            entry.on('end', () => {
                const buffer = Buffer.concat(parts);
                if (path.basename(filepath).toLowerCase() === 'project.xml') {
                    xml = buffer.toString();
                    if (unpacked) return load();
                } else if (!unpacked && entry.type === 'Directory') {
                    todo.push((next) => { fs.mkdir(base + '/' + filepath, next); });
                } else if (!unpacked && entry.type === 'File') {
                    todo.push((next) => { fs.writeFile(base + '/' + filepath, buffer, next); });
                }
            });
        });
        parser.on('end', () => {
            // Load was called early via parser. Do nothing.
            if (unpacked && xml) return;

            // Package unpacked but no project.xml. Call load to error our.
            if (unpacked) return load();

            // Callback already called with an error.
            if (once) return;

            todo.push((next) => { fs.writeFile(base + '/.unpacked', '', next); });
            const next = (err) => {
                if (err && err.code !== 'EEXIST') return error(err);
                if (todo.length) {
                    todo.shift()(next);
                } else {
                    unpacked = true;
                    load();
                }
            };
            next();
        });
        gunzip.on('error', error);
        parser.on('error', error);

        switch (uri.protocol) {
            case 'tm2z:':
                // The uri from unpacker has already been pulled
                // down from S3.
                stream = fs.createReadStream(uri.pathname)
                    .on('data', chunked)
                    .pipe(gunzip)
                    .pipe(parser)
                    .on('error', error);
                break;
            case 'tm2z+http:':
                uri.protocol = 'http:';
                stream = request({ uri: uri, encoding:null }, (err, res, body) => {
                    if (err) {
                        error(err);
                    } else if (res.headers['content-length'] && parseInt(res.headers['content-length'],10) !== body.length) {
                        error(new Error('Content-Length does not match response body length'));
                    }
                })
                    .on('data', chunked)
                    .pipe(gunzip)
                    .pipe(parser)
                    .on('error', error);
                break;
            case 'tm2z+s3:': {
                const s3 = new AWS.S3();
                stream = s3.getObject(s3urls.fromUrl(uri.href.replace('tm2z+', '')))
                    .createReadStream()
                    .on('data', chunked)
                    .on('error', error)
                    .pipe(gunzip)
                    .pipe(parser)
                    .on('error', error);
            }
                break;
        }
    }

    function load() {
        if (once++) return;
        if (!xml) return callback(new Error('project.xml not found in package'));
        Vector({
            source: 'mapbox:///mapbox.mapbox-streets-v4',
            base: base,
            xml: xml
        }, callback);
    }
}

tm2z.findID = (source, id, callback) => {
    callback(new Error('id not found'));
};

function xray(opts, callback) {
    Backend(opts, (err, backend) => {
        if (err) return callback(err);
        if (!backend._vector_layers) return callback(new Error('source must contain a vector_layers property'));
        Vector({
            xml: xray.xml({
                map_properties: opts.transparent ? '' : 'background-color="#000000"',
                vector_layers: backend._vector_layers
            }),
            backend: backend
        }, (err, source) => {
            if (err) return callback(err);
            source._xray = true;
            return callback(null, source);
        });
    });
}

xray.xml = function(opts) {
    return util.format(xray.templates.map, opts.map_properties, opts.vector_layers.map((layer) => {
        const rgb = xray.color(layer.id).join(',');
        return util.format(xray.templates.layer, layer.id, rgb, rgb, rgb, rgb, rgb, layer.id, layer.id, layer.id, layer.id);
    }).join('\n'));
};

// Templates for generating xray styles.
xray.templates = {};
xray.templates.map = fs.readFileSync(path.join(__dirname, 'templates', 'map.xml'), 'utf8');
xray.templates.layer = fs.readFileSync(path.join(__dirname, 'templates', 'layer.xml'), 'utf8');
xray.templates.params = fs.readFileSync(path.join(__dirname, 'templates', 'params.xml'), 'utf8');

xray.color = function(str) {
    const rgb = [0, 0, 0];
    for (let i = 0; i < str.length; i++) {
        const v = str.charCodeAt(i);
        rgb[v % 3] = (rgb[i % 3] + (13 * (v % 13))) % 12;
    }
    let r = 4 + rgb[0];
    let g = 4 + rgb[1];
    let b = 4 + rgb[2];
    r = (r * 16) + r;
    g = (g * 16) + g;
    b = (b * 16) + b;
    return [r,g,b];
};

module.exports = Vector;
module.exports.tm2z = tm2z;
module.exports.xray = xray;
module.exports.mapnik = mapnik;
module.exports.Backend = Backend;
module.exports.strict = true;

