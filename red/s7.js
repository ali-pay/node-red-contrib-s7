//@ts-check
/*
  Copyright: (c) 2016-2020, St-One Ltda., Guilherme Francescon Cittolin <guilherme@st-one.io>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

function nrInputShim(node, fn) {
    node.on('input', function (msg, send, done) {
        send = send || node.send;
        done = done || (err => err && node.error(err, msg));
        fn(msg, send, done);
    });
}

/**
 * Compares values for equality, includes special handling for arrays. Fixes #33
 * @param {number|string|Array|Date} a
 * @param {number|string|Array|Date} b 
 */
function equals(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length != b.length) return false;

        for (var i = 0; i < a.length; ++i) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    return false;
}

var MIN_CYCLE_TIME = 50;

var tools = require('../src/tools.js');

module.exports = function (RED) {
    "use strict";

    var nodes7 = require('@st-one-io/nodes7');
    var EventEmitter = require('events').EventEmitter;

    // ---------- Discovery Endpoints ----------

    RED.httpAdmin.get('/__node-red-contrib-s7/discover/available/iso-on-tcp', RED.auth.needsPermission('s7.discover'), function (req, res) {
        tools.isPnToolsAvailable().then(function (available) {
            res.json(available).end();
        }).catch(() => {
            res.status(500).end();
        });
    });

    RED.httpAdmin.get('/__node-red-contrib-s7/discover/iso-on-tcp', RED.auth.needsPermission('s7.discover'), function (req, res) {
        tools.listDevicesPN().then(function (devices) {
            res.json(devices).end();
        }).catch(() => {
            res.status(500).end();
        });
    });

    RED.httpAdmin.get('/__node-red-contrib-s7/flashled/iso-on-tcp/:mac', RED.auth.needsPermission('s7.discover'), function (req, res) {
        let mac_addr = (req.params.mac || '').replace(/-/g, ':');
        if (!/^([A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/.test(mac_addr)) {
            res.status(400).end();
            return;
        }

        tools.flashLedPN(mac_addr).then(function () {
            res.status(204).end();
        }).catch(() => {
            res.status(500).end();
        });
    });

    // ---------- S7 Endpoint ----------

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function generateStatus(status, val) {
        var obj;

        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._("s7.endpoint.status.online");
        }

        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'badvalues':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("s7.endpoint.status.badvalues")
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._("s7.endpoint.status.offline")
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("s7.endpoint.status.connecting")
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._("s7.endpoint.status.unknown")
                };
        }
        return obj;
    }

    function validateTSAP(num) {
        num = num.toString();
        if (num.length != 2) return false;
        if (!(/^[0-9a-fA-F]+$/.test(num))) return false;
        var i = parseInt(num, 16);
        if (isNaN(i) || i < 0 || i > 0xff) return false;
        return true;
    }

    function S7Endpoint(config) {
        EventEmitter.call(this);
        var node = this;
        var oldValues = {};
        var status;
        var readInProgress = false;
        var readDeferred = 0;
        var connected = false;
        var currentCycleTime = config.cycletime;
        var transport = config.transport || 'iso-on-tcp';

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of S7In nodes
        this.setMaxListeners(0);

        node.endpoint = null;
        let connOpts;
        let itemGroup;
        let s7ConnOpts = { timeout: parseInt(config.timeout) }

        if (transport === 'mpi-s7') {

            node.adapter = RED.nodes.getNode(config.adapter);
            if (!node.adapter) {
                return node.error(RED._("s7.error.missingconfig"));
            }

            s7ConnOpts.maxJobs = 1;

            connOpts = {
                customTransport: async () => node.adapter.getStream(config.busaddr),
                s7ConnOpts
            }

        } else if (transport === 'iso-on-tcp') {

            switch (config.connmode) {
                case "rack-slot":
                    connOpts = {
                        host: config.address,
                        port: Number(config.port),
                        rack: Number(config.rack),
                        slot: Number(config.slot),
                        s7ConnOpts: s7ConnOpts
                    }
                    break;
                case "tsap":
                    if (!validateTSAP(config.localtsaphi) ||
                        !validateTSAP(config.localtsaplo) ||
                        !validateTSAP(config.remotetsaphi) ||
                        !validateTSAP(config.remotetsaplo)) {
                        node.error(RED._("s7.error.invalidtsap", config));
                        return;
                    }

                    let localTSAP = parseInt(config.localtsaphi, 16) << 8;
                    localTSAP += parseInt(config.localtsaplo, 16);
                    let remoteTSAP = parseInt(config.remotetsaphi, 16) << 8;
                    remoteTSAP += parseInt(config.remotetsaplo, 16);

                    connOpts = {
                        host: config.address,
                        port: config.port,
                        srcTSAP: localTSAP,
                        dstTSAP: remoteTSAP,
                        s7ConnOpts: s7ConnOpts
                    }
                    break;
                default:
                    node.error(RED._("s7.error.invalidconntype", config));
                    return;
            }
        } else {
            node.error(RED._("s7.error.invalidconntype", config));
            return;
        }

        node._vars = createTranslationTable(config.vartable);

        node.getStatus = function getStatus() {
            return status;
        };

        node.writeVar = function writeVar(obj) {
            itemGroup.writeItems(obj.name, obj.val)
                .then(() => obj.done())
                .catch(e => obj.done(e))
        };

        /**
         * updates the current cycle time on the fly. A value of 0
         * disables the cyclic reading of variables, and for positive values
         * a minimum of 50 ms is enforced
         * 
         * @param {number} interval the cycle time interval, in ms
         * @returns {string|undefined} an string with the error if any, or undefined
         */
        node.updateCycleTime = function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                return RED._("s7.error.invalidtimeinterval", { interval: interval });
            }

            clearInterval(node._td);

            // don't set a new timer if value is zero
            if (!time) return;

            if (time < MIN_CYCLE_TIME) {
                node.warn(RED._("s7.info.cycletimetooshort", { min: MIN_CYCLE_TIME }), {});
                time = MIN_CYCLE_TIME;
            }

            currentCycleTime = time;
            node._td = setInterval(doCycle, time);
        }

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('__STATUS__', {
                status: status
            });
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus('online');

            var changed = false;
            node.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    node.emit(key, values[key]);
                    node.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) node.emit('__ALL_CHANGED__', values);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                itemGroup.readAllItems().then(cycleCallback).catch(e => {
                    node.error(e, {});
                    readInProgress = false;
                });
                readInProgress = true;
            } else {
                readDeferred++;
            }
        }
        node.doCycle = doCycle;

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            manageStatus('online');

            node.updateCycleTime(currentCycleTime);
        }

        function onDisconnect() {
            manageStatus('offline');
            connected = false;
        }

        node.on('close', done => {
            manageStatus('offline');
            if (!node.endpoint) done();

            node.endpoint.disconnect().then(done).catch(e => {
                node.error(e);
            });
        });

        manageStatus('offline');

        node.endpoint = new nodes7.S7Endpoint(connOpts);
        node.endpoint.on('connecting', () => manageStatus('connecting'));
        node.endpoint.on('connect', onConnect);
        node.endpoint.on('disconnect', onDisconnect);
        node.endpoint.on('error', (e => {
            manageStatus('offline');
            node.error(e && e.toString(), {});
        }));

        itemGroup = new nodes7.S7ItemGroup(node.endpoint);
        itemGroup.setTranslationCB(k => node._vars[k]);

        let varKeys = Object.keys(node._vars)
        if (!varKeys || !varKeys.length) {
            node.warn(RED._("s7.info.novars"), {});
            return;
        } else {
            itemGroup.addItems(varKeys);
        }

        // 将字段加入s7 endpoint节点对象中
        node.itemGroup = itemGroup;
        node.rewritetimes = parseInt(config.rewritetimes);
        node.rewriteinterval = parseInt(config.rewriteinterval);
    }
    RED.nodes.registerType("s7 endpoint", S7Endpoint);

    // ---------- S7 In ----------

    function S7In(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("s7.error.missingconfig"));
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                topic: key,
                payload: data,
                _s7: {
                    plc: node.endpoint.name,
                    ip: node.endpoint.endpoint._connOptsTcp.host,
                    status: node.endpoint.getStatus() === 'online' ? '在线' : '离线',
                    time: new Date(),
                }
            };
            statusVal = status !== undefined ? status : data;
            node.send(msg);
            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));

            // 只触发 ['online', 'offline'] 的事件
            // if (!['online', 'offline'].includes(node.endpoint.getStatus())) return;
            var msg = {
                topic: '',
                payload: {},
                _s7: {
                    plc: node.endpoint.name,
                    ip: node.endpoint.endpoint._connOptsTcp.host,
                    status: node.endpoint.getStatus() === 'online' ? '在线' : '离线',
                    time: new Date(),
                }
            };
            node.send(msg);
        }

        node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        node.endpoint.on('__STATUS__', onEndpointStatus);

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    node.endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    node.endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    node.endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    node.endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    node.endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    node.endpoint.on('__ALL__', onData);
            }
        }

        node.on('close', function (done) {
            node.endpoint.removeListener('__ALL__', onDataSelect);
            node.endpoint.removeListener('__ALL__', onDataSplit);
            node.endpoint.removeListener('__ALL__', onData);
            node.endpoint.removeListener('__ALL_CHANGED__', onData);
            node.endpoint.removeListener('__CHANGED__', onChanged);
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            node.endpoint.removeListener(config.variable, onData);
            done();
        });
    }
    RED.nodes.registerType("s7 in", S7In);

    // ---------- S7 Out ----------

    function S7Out(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("s7.error.missingconfig"));
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function onNewMsg(msg, send, done) {
            var writeObj = {
                name: config.variable || msg.variable,
                val: msg.payload,
                done: (error) => {

                    /**
                     * 第一次写入数据后，会进入本函数
                     */

                    // 写入的键
                    const variable = config.variable || msg.variable
                    // 写入的值
                    const payload = msg.payload
                    // 写入的键（数组）
                    const variables = Array.isArray(variable) ? variable : [variable]
                    // 写入的值（数组）
                    const payloads = Array.isArray(payload) ? payload : [payload]

                    // 写入的键值对
                    const values = {}
                    variables.forEach((key, index) => {
                        values[key] = payloads[index]
                    })

                    // 调用 s7-out 后的输出消息
                    msg._s7 = {
                        plc: node.endpoint.name,
                        ip: node.endpoint.endpoint._connOptsTcp.host,
                        status: node.endpoint.getStatus() === 'online' ? '在线' : '离线',
                        time: new Date(),
                    }
                    msg.payload = {
                        variable: variable, // 写入的键
                        payload: payload,   // 写入的值
                        values: values,     // 写入的键值对
                        newValues: {},      // plc的最新键值对
                        wrongValues: {},    // 跟写入值不一致的键值对
                        bingo: false,       // plc的最新值跟写入值是否一致
                        error: error,       // 错误
                        rewriteCount: 0,    // 已重写次数
                    }

                    // 处理错误 done(e) 不生效；需要使用 node.error(e)
                    // https://nodered.org/docs/creating-nodes/node-js#handling-errors
                    if (error) {
                        node.error(error)
                        node.send(msg)
                        return
                    }

                    // 读取最新的值判断是否需要重写数据
                    async function rewrite() {
                        // 延时读取最新的值
                        if (node.endpoint.rewritetimes && node.endpoint.rewriteinterval) await new Promise(resolve => setTimeout(resolve, node.endpoint.rewriteinterval))
                        try {

                            // 清空上一次记录的数据
                            msg.payload.newValues = {}
                            msg.payload.wrongValues = {}

                            // 读取最新的值
                            const newValues = await node.endpoint.itemGroup.readAllItems()
                            for (const key in newValues) {
                                // 只匹配此次写入的变量
                                if (variables.includes(key)) {
                                    // plc的最新键值对
                                    msg.payload.newValues[key] = newValues[key]
                                    // 跟写入值不一致的键值对
                                    if (newValues[key] !== values[key]) msg.payload.wrongValues[key] = newValues[key]
                                }
                            }
                            // 判断数据是否完全写入成功
                            const v1 = Object.keys(msg.payload.values).length
                            const v2 = Object.keys(msg.payload.newValues).length
                            const v3 = Object.keys(msg.payload.wrongValues).length
                            msg.payload.bingo = v1 === v2 && v3 === 0
                        } catch (e) {
                            // node.error(e)
                        }
                        // 判断是否需要重写数据
                        if (!msg.payload.bingo && node.endpoint.rewritetimes > msg.payload.rewriteCount) {

                            // 递增已重写次数
                            msg.payload.rewriteCount++

                            // 想查看重写记录时，可以注释这句话
                            // console.log(`[${new Date().toLocaleString()}]重写：`, msg.payload.rewriteCount, msg.payload.wrongValues, msg.payload.newValues, msg.payload.values)

                            try {
                                await node.endpoint.itemGroup.writeItems(writeObj.name, writeObj.val)
                            }
                            catch (e) {
                                // node.error(e)
                            }
                            // 读取最新的值判断是否需要重写数据
                            await rewrite()
                            return
                        }

                        // 输出消息
                        node.send(msg)
                    }

                    // 读取最新的值判断是否需要重写数据
                    rewrite()
                }
            };

            // Test for the case we're writing multiple vars
            if (Array.isArray(writeObj.name)) {

                if (!Array.isArray(writeObj.val) || writeObj.val.length !== writeObj.name.length) {
                    node.error(RED._("s7.error.valmismatch"));
                    node.status(generateStatus('badvalues', statusVal));
                    return;
                }

                for (const elm of writeObj.name) {
                    if (!node.endpoint._vars[elm]) {
                        node.error(RED._("s7.error.varunknown", { var: elm }));
                        node.status(generateStatus('badvalues', statusVal));
                        return;
                    }
                }

            } else if (!node.endpoint._vars[writeObj.name]) {
                node.error(RED._("s7.error.varunknown", { var: writeObj.name }));
                node.status(generateStatus('badvalues', statusVal));
                return;
            }

            statusVal = writeObj.val;
            node.endpoint.writeVar(writeObj);
            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        nrInputShim(node, onNewMsg);

        node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        node.endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            done();
        });

    }
    RED.nodes.registerType("s7 out", S7Out);


    // ---------- S7 Control ----------

    function S7Control(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("s7.error.missingconfig"));
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function onMessage(msg, send, done) {
            var res;
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    res = node.endpoint.updateCycleTime(msg.payload);
                    if (res) {
                        done(res);
                    } else {
                        send(msg);
                        done();
                    }
                    break;
                case 'trigger':
                    node.endpoint.doCycle();
                    send(msg);
                    done();
                    break;

                case 'ssl':
                    node.endpoint.endpoint
                        .getSSL(Number(msg && msg.payload && msg.payload.id || 0), Number(msg && msg.payload && msg.payload.index || 0)).then(res => {
                            msg.payload = res;
                            send(msg);
                            done();
                        }).catch(e => {
                            done(e);
                        })
                    break;

                case 'list-blocks':
                    node.endpoint.endpoint
                        .listAllBlocks().then(res => {
                            msg.payload = res;
                            send(msg);
                            done();
                        }).catch(e => {
                            done(e);
                        })
                    break;

                case 'upload-block':
                    node.endpoint.endpoint
                        .uploadBlock(msg && msg.payload && msg.payload.type, Number(msg && msg.payload && msg.payload.number)).then(res => {
                            msg.payload = res;
                            send(msg);
                            done();
                        }).catch(e => {
                            done(e);
                        })
                    break;

                case 'upload-all-blocks':
                    node.endpoint.endpoint
                        .uploadAllBlocks().then(res => {
                            msg.payload = res;
                            send(msg);
                            done();
                        }).catch(e => {
                            done(e);
                        })
                    break;

                case 'all-block-info':
                    node.endpoint.endpoint
                        .getAllBlockInfo().then(res => {
                            msg.payload = res;
                            send(msg);
                            done();
                        }).catch(e => {
                            done(e);
                        })
                    break;

                default:
                    node.error(RED._("s7.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        node.status(generateStatus(node.endpoint.getStatus(), statusVal));

        nrInputShim(node, onMessage);
        node.endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            done();
        });

    }
    RED.nodes.registerType("s7 control", S7Control);
};
