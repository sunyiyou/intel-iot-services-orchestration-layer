/******************************************************************************
Copyright (c) 2015, Intel Corporation

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of Intel Corporation nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*****************************************************************************/
'use strict';

var mailcomposer = require('mailcomposer');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var directTransport = require('nodemailer-direct-transport');
var smtpTransport = require('nodemailer-smtp-transport');
var packageData = require('../package.json');
var fs = require('fs');
var needle = require('needle');
var PassThrough = require('stream').PassThrough;

// Export createTransport method
module.exports.createTransport = function(transporter) {
    transporter = transporter || directTransport({
        debug: true
    });

    if (typeof transporter === 'object' && typeof transporter.send !== 'function') {
        transporter = smtpTransport(transporter);
    }

    return new Nodemailer(transporter);
};

/**
 * Creates an object for exposing the Nodemailer API
 *
 * @constructor
 * @param {Object} transporter Transport object instance to pass the mails to
 */
function Nodemailer(transporter) {
    EventEmitter.call(this);

    this._plugins = {
        compile: [],
        stream: []
    };

    this.transporter = transporter;

    if (typeof transporter.on === 'function') {
        this.transporter.on('log', this.emit.bind(this, 'log'));
        this.transporter.on('error', this.emit.bind(this, 'error'));
    }
}
util.inherits(Nodemailer, EventEmitter);

Nodemailer.prototype.use = function(step, plugin) {
    step = (step || '').toString();
    if (!this._plugins.hasOwnProperty(step)) {
        this._plugins[step] = [plugin];
    } else {
        this._plugins[step].push(plugin);
    }
};

/**
 * Optional close method, passed to the underlying transport object
 */
Nodemailer.prototype.close = function( /* possible arguments */ ) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof this.transporter.close === 'function') {
        this.transporter.close.apply(this.transporter, args);
    }
};

/**
 * Sends an email using the preselected transport object
 *
 * @param {Object} data E-data description
 * @param {Function} callback Callback to run once the sending succeeded or failed
 */
Nodemailer.prototype.sendMail = function(data, callback) {
    data = data || {};
    data.headers = data.headers || {};
    callback = callback || function() {};

    var mail = {
        data: data,
        message: null,
        resolveContent: this.resolveContent.bind(this)
    };

    if (typeof this.transporter === 'string') {
        return callback(new Error('Unsupported configuration, downgrade Nodemailer to v0.7.1 or see the migration guide https://github.com/andris9/Nodemailer#migration-guide'));
    }

    this._processPlugins('compile', mail, function(err) {
        if (err) {
            return callback(err);
        }

        mail.message = mailcomposer(mail.data);

        if (mail.data.xMailer !== false) {
            mail.message.setHeader('X-Mailer', mail.data.xMailer || this._getVersionString());
        }

        if (mail.data.priority) {
            switch((mail.data.priority || '').toString().toLowerCase()){
                case 'high':
                    mail.message.setHeader('X-Priority', '1 (Highest)');
                    mail.message.setHeader('X-MSMail-Priority', 'High');
                    mail.message.setHeader('Importance', 'High');
                    break;
                case 'low':
                    mail.message.setHeader('X-Priority', '5 (Lowest)');
                    mail.message.setHeader('X-MSMail-Priority', 'Low');
                    mail.message.setHeader('Importance', 'Low');
                    break;
                default:
                    // do not add anything, since all messages are 'Normal' by default
            }
        }

        this._processPlugins('stream', mail, function(err) {
            if (err) {
                return callback(err);
            }
            this.transporter.send(mail, callback);
        }.bind(this));
    }.bind(this));
};

/**
 * Resolves a String or a Buffer value for content value. Useful if the value
 * is a Stream or a file or an URL. If the value is a Stream, overwrites
 * the stream object with the resolved value (you can't stream a value twice).
 *
 * This is useful when you want to create a plugin that needs a content value,
 * for example the `html` or `text` value as a String or a Buffer but not as
 * a file path or an URL.
 *
 * @param {Object} data An object or an Array you want to resolve an element for
 * @param {String|Number} key Property name or an Array index
 * @param {Function} callback Callback function with (err, value)
 */
Nodemailer.prototype.resolveContent = function(data, key, callback) {
    var content = data && data[key] && data[key].content || data[key];
    var contentStream;
    var encoding = (typeof data[key] === 'object' && data[key].encoding || 'utf8')
        .toString()
        .toLowerCase()
        .replace(/[-_\s]/g, '');

    if (!content) {
        return callback(null, content);
    }

    if (typeof content === 'object') {
        if (typeof content.pipe === 'function') {
            return this._resolveStream(content, function(err, value) {
                if (err) {
                    return callback(err);
                }
                // we can't stream twice the same content, so we need
                // to replace the stream object with the streaming result
                data[key] = value;
                callback(null, value);
            }.bind(this));
        } else if (/^https?:\/\//i.test(content.path || content.href)) {
            contentStream = new PassThrough();
            needle.get(content.path || content.href, {
                decode_response: false,
                parse_response: false,
                compressed: true,
                follow_max: 5
            }).on('end', function(err) {
                if (err) {
                    contentStream.emit('error', err);
                }
                contentStream.emit('end');
            }).pipe(contentStream, {
                end: false
            });
            return this._resolveStream(contentStream, callback);
        } else if (/^data:/i.test(content.path || content.href)) {
            var parts = (content.path || content.href).match(/^data:((?:[^;]*;)*(?:[^,]*)),(.*)$/i);
            if (!parts) {
                return callback(null, new Buffer(0));
            }
            return callback(null, /\bbase64$/i.test(parts[1]) ? new Buffer(parts[2], 'base64') : new Buffer(decodeURIComponent(parts[2])));
        } else if (content.path) {
            return this._resolveStream(fs.createReadStream(content.path), callback);
        }
    }

    if (typeof data[key].content === 'string' && ['utf8', 'usascii', 'ascii'].indexOf(encoding) < 0) {
        content = new Buffer(data[key].content, encoding);
    }

    // default action, return as is
    callback(null, content);
};

/**
 * Streams a stream value into a Buffer
 *
 * @param {Object} stream Readable stream
 * @param {Function} callback Callback function with (err, value)
 */
Nodemailer.prototype._resolveStream = function(stream, callback) {
    var responded = false;
    var chunks = [];
    var chunklen = 0;

    stream.on('error', function(err) {
        if (responded) {
            return;
        }

        responded = true;
        callback(err);
    });

    stream.on('data', function(chunk) {
        if (chunk && chunk.length) {
            chunks.push(chunk);
            chunklen += chunk.length;
        }
    });

    stream.on('end', function() {
        if (responded) {
            return;
        }
        responded = true;

        var value;

        try {
            value = Buffer.concat(chunks, chunklen);
        } catch (E) {
            return callback(E);
        }
        callback(null, value);
    });
};

Nodemailer.prototype._getVersionString = function() {
    return util.format(
        '%s (%s; +%s; %s/%s)',
        packageData.name,
        packageData.version,
        packageData.homepage,
        this.transporter.name,
        this.transporter.version
    );
};

Nodemailer.prototype._processPlugins = function(step, mail, callback) {
    step = (step || '').toString();

    if (!this._plugins.hasOwnProperty(step) || !this._plugins[step].length) {
        return callback(null);
    }

    var plugins = Array.prototype.slice.call(this._plugins[step]);

    var processPlugins = function() {
        if (!plugins.length) {
            return callback(null);
        }
        var plugin = plugins.shift();
        plugin(mail, function(err) {
            if (err) {
                return callback(err);
            }
            processPlugins();
        });
    }.bind(this);

    processPlugins();
};