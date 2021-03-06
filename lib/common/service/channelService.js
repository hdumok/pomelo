var countDownLatch = require('../../util/countDownLatch');
var utils = require('../../util/utils');
var ChannelRemote = require('../remote/frontend/channelRemote');
var logger = require('pomelo-logger').getLogger('pomelo', __filename);

/**
 * constant
 */
var ST_INITED = 0;
var ST_DESTROYED = 1;

/**
 * Create and maintain channels for server local.
 *
 * ChannelService is created by channel component which is a default loaded
 * component of pomelo and channel service would be accessed by `app.get('channelService')`.
 *
 * @class
 * @constructor
 */
var ChannelService = function(app, opts) {
  opts = opts || {};
  this.app = app;
  this.channels = {};
  this.prefix = opts.prefix;
  this.store = opts.store; //自定义通道存储工具
  this.broadcastFilter = opts.broadcastFilter;
  this.channelRemote = new ChannelRemote(app);
};

module.exports = ChannelService;


ChannelService.prototype.start = function(cb) {
  restoreChannel(this, cb);
};



/**
 * Create channel with name.
 *
 * @param {String} name channel's name
 * @memberOf ChannelService
 */
ChannelService.prototype.createChannel = function(name) {
  if(this.channels[name]) {
    return this.channels[name];
  }

  var c = new Channel(name, this);
  //将通道加入通道队列
  addToStore(this, genKey(this), genKey(this, name));
  this.channels[name] = c;
  return c;
};

/**
 * Get channel by name.
 *
 * @param {String} name channel's name
 * @param {Boolean} create if true, create channel
 * @return {Channel}
 * @memberOf ChannelService
 */
ChannelService.prototype.getChannel = function(name, create) {
  var channel = this.channels[name];
  if(!channel && !!create) {
    channel = this.channels[name] = new Channel(name, this);
    addToStore(this, genKey(this), genKey(this, name));
  }
  return channel;
};

/**
 * Destroy channel by name.
 *
 * @param {String} name channel name
 * @memberOf ChannelService
 */
ChannelService.prototype.destroyChannel = function(name) {
  delete this.channels[name];
  //从通道队里里删除该通道
  removeFromStore(this, genKey(this), genKey(this, name));

  //删除该通道的所有成员
  removeAllFromStore(this, genKey(this, name));
};

/**
 * Push message by uids.
 * Group the uids by group. ignore any uid if sid not specified.
 *
 * @param {String} route message route
 * @param {Object} msg message that would be sent to client
 * @param {Array} uids the receiver info list, [{uid: userId, sid: frontendServerId}]
 * @param {Object} opts user-defined push options, optional 
 * @param {Function} cb cb(err)
 * @memberOf ChannelService
 */
//也就是说，当后端服务器知道 用户在前端服务器的存储情况，是可以推送消息给用户的，但是问题就在于，后端进程有多个，玩家可能加入了不同的通道服务器
//而销毁通道的是其中一个玩家，通过共享内存，可以实现玩家在不同服务器里也可以战斗，但是如果游戏结束，一部分人无法退出通道？？？？
ChannelService.prototype.pushMessageByUids = function(route, msg, uids, opts, cb) {
  if(typeof route !== 'string') {
    cb = opts;
    opts = uids;
    uids = msg;
    msg = route;
    route = msg.route;
  }

  if(!cb && typeof opts === 'function') {
    cb = opts;
    opts = {};
  }

  if(!uids || uids.length === 0) {
    utils.invokeCallback(cb, new Error('uids should not be empty'));
    return;
  }
  var groups = {}, record;
  for(var i=0, l=uids.length; i<l; i++) {
    record = uids[i];
    add(record.uid, record.sid, groups); // groups[sid] = [uid];
  }

  sendMessageByGroup(this, route, msg, groups, opts, cb);
};

/**
 * Broadcast message to all the connected clients.
 *
 * @param  {String}   stype      frontend server type string
 * @param  {String}   route      route string
 * @param  {Object}   msg        message
 * @param  {Object}   opts       user-defined broadcast options, optional
 *                               opts.binded: push to binded sessions or all the sessions
 *                               opts.filterParam: parameters for broadcast filter.
 * @param  {Function} cb         callback
 * @memberOf ChannelService
 */
ChannelService.prototype.broadcast = function(stype, route, msg, opts, cb) {
  var app = this.app;
  var namespace = 'sys';
  var service = 'channelRemote';
  var method = 'broadcast';
  var servers = app.getServersByType(stype);

  if(!servers || servers.length === 0) {
    // server list is empty
    utils.invokeCallback(cb);
    return;
  }

  var count = servers.length;
  var successFlag = false;

  var latch = countDownLatch.createCountDownLatch(count, function() {
    if(!successFlag) {
      utils.invokeCallback(cb, new Error('broadcast fails'));
      return;
    }
    utils.invokeCallback(cb, null);
  });

  var genCB = function(serverId) {
    return function(err) {
      if(err) {
        logger.error('[broadcast] fail to push message to serverId: ' + serverId + ', err:' + err.stack);
        latch.done();
        return;
      }
      successFlag = true;
      latch.done();
    };
  };

  var self = this;
  var sendMessage = function(serverId) {
    return (function() {
      if(serverId === app.serverId) {
        //调用系统的远程broadcast调用接口调用
        self.channelRemote[method](route, msg, opts, genCB());
      } else {
        app.rpcInvoke(serverId, {namespace: namespace, service: service,
          method: method, args: [route, msg, opts]}, genCB(serverId));
      }
    }());
  };

  opts = {type: 'broadcast', userOptions: opts || {}};

  // for compatiblity 
  opts.isBroadcast = true;
  if(opts.userOptions) {
    opts.binded = opts.userOptions.binded;
    opts.filterParam = opts.userOptions.filterParam;
  }

  //广播自带群发
  for(var i=0, l=count; i<l; i++) {
    sendMessage(servers[i].id);
  }
};

/**
 * Channel maintains the receiver collection for a subject. You can
 * add users into a channel and then broadcast message to them by channel.
 *
 * @class channel
 * @constructor
 */
var Channel = function(name, service) {
  this.name = name;
  //本机通道存储，通过服务器id sid存储
  this.groups = {};       // group map for uids. key: sid, value: [uid]

  //在记录在其他进程的user个与进程的映射
  this.records = {};      // member records. key: uid
  this.__channelService__ = service;
  this.state = ST_INITED;
  this.userAmount =0;
};

/**
 * Add user to channel.
 *
 * @param {Number} uid user id
 * @param {String} sid frontend server id which user has connected to
 */
Channel.prototype.add = function(uid, sid) {
  if(this.state > ST_INITED) {
    return false;
  } else {
    //this.groups是本进程的通道缓存
    var res = add(uid, sid, this.groups);
    //如果该uid有对应的sid,也就是知道该uid在某台server上，记录下来
    if(res) {
      this.records[uid] = {sid: sid, uid: uid};
      this.userAmount =this.userAmount+1;
    }
    //在某个指定通道里存储某个成员，sid是前端进程serverId
    addToStore(this.__channelService__, genKey(this.__channelService__, this.name), genValue(sid, uid));
    return res;
  }
};

/**
 * Remove user from channel.
 *
 * @param {Number} uid user id
 * @param {String} sid frontend server id which user has connected to.
 * @return [Boolean] true if success or false if fail
 */
Channel.prototype.leave = function(uid, sid) {
  if(!uid || !sid) {
    return false;
  }

  //在本机前端服务器/用户通道缓存里删除该用户
  var res = deleteFrom(uid, sid, this.groups[sid]);
  if(res){
    //并删除该用户的用户通道映射关系
    delete this.records[uid];
    this.userAmount = this.userAmount-1;
  }
  if(this.userAmount<0) this.userAmount=0;//robust
  removeFromStore(this.__channelService__, genKey(this.__channelService__, this.name), genValue(sid, uid));
  if(this.groups[sid] && this.groups[sid].length === 0) {
    delete this.groups[sid];
  }
  return res;
};
/**
 * Get channel UserAmount in a channel.

 *
 * @return {number } channel member amount
 */
Channel.prototype.getUserAmount = function() {
  return this.userAmount;
};

/**
 * Get channel members.
 *
 * <b>Notice:</b> Heavy operation.
 *
 * @return {Array} channel member uid list
 */
Channel.prototype.getMembers = function() {
  var res = [], groups = this.groups;
  var group, i, l;
  for(var sid in groups) {
    group = groups[sid];
    for(i=0, l=group.length; i<l; i++) {
      res.push(group[i]); //uid list
    }
  }
  return res;
};

/**
 * Get Member info.
 *
 * @param  {String} uid user id
 * @return {Object} member info
 */
Channel.prototype.getMember = function(uid) {
  return this.records[uid]; //{sid: sid, uid: uid};
};

/**
 * Destroy channel.
 */
Channel.prototype.destroy = function() {
  this.state = ST_DESTROYED;
  this.__channelService__.destroyChannel(this.name);
};

/**
 * Push message to all the members in the channel
 *
 * @param {String} route message route
 * @param {Object} msg message that would be sent to client
 * @param {Object} opts user-defined push options, optional
 * @param {Function} cb callback function
 */
Channel.prototype.pushMessage = function(route, msg, opts, cb) {
  if(this.state !== ST_INITED) {
    utils.invokeCallback(new Error('channel is not running now'));
    return;
  }

  if(typeof route !== 'string') {
    cb = opts;
    opts = msg;
    msg = route;
    route = msg.route;
  }

  if(!cb && typeof opts === 'function') {
    cb = opts;
    opts = {};
  }

  sendMessageByGroup(this.__channelService__, route, msg, this.groups, opts, cb);
};

/**
 * add uid and sid into group. ignore any uid that uid not specified.
 *
 * @param uid user id
 * @param sid server id
 * @param groups {Object} grouped uids, , key: sid, value: [uid]
 */
var add = function(uid, sid, groups) {
  if(!sid) {
    logger.warn('ignore uid %j for sid not specified.', uid);
    return false;
  }

  var group = groups[sid];
  if(!group) {
    group = [];
    groups[sid] = group;
  }

  group.push(uid);
  return true;
};

/**
 * delete element from array
 */
var deleteFrom = function(uid, sid, group) {
  if(!uid || !sid || !group) {
    return false;
  }

  for(var i=0, l=group.length; i<l; i++) {
    if(group[i] === uid) {
      group.splice(i, 1);
      return true;
    }
  }

  return false;
};

/**
 * push message by group
 *
 * @param route {String} route route message
 * @param msg {Object} message that would be sent to client
 * @param groups {Object} grouped uids, , key: sid, value: [uid]
 * @param opts {Object} push options
 * @param cb {Function} cb(err)
 *
 * @api private
 */
var sendMessageByGroup = function(channelService, route, msg, groups, opts, cb) {
  var app = channelService.app;
  var namespace = 'sys';
  var service = 'channelRemote';
  var method = 'pushMessage';
  var count = utils.size(groups); //这是个对象
  var successFlag = false;
  var failIds = [];

  logger.debug('[%s] channelService sendMessageByGroup route: %s, msg: %j, groups: %j, opts: %j', app.serverId, route, msg, groups, opts);
  if(count === 0) {
    // group is empty
    utils.invokeCallback(cb);
    return;
  }

  var latch = countDownLatch.createCountDownLatch(count, function() {
    if(!successFlag) {
      utils.invokeCallback(cb, new Error('all uids push message fail'));
      return;
    }
    utils.invokeCallback(cb, null, failIds);
  });

  var rpcCB = function(serverId) {
    return function(err, fails) {
      if(err) {
        logger.error('[pushMessage] fail to dispatch msg to serverId: ' + serverId + ', err:' + err.stack);
        latch.done();
        return;
      }
      if(fails) {
        failIds = failIds.concat(fails);
      }
      successFlag = true;
      latch.done();
    };
  };

  opts = {type: 'push', userOptions: opts || {}};
  // for compatiblity
  opts.isPush = true;
  
  var sendMessage = function(sid) {
    return (function() {
      //如果在本机，那直接调用获取本机的通道并发送
      if(sid === app.serverId) {
        channelService.channelRemote[method](route, msg, groups[sid], opts, rpcCB(sid));
      } else {
        app.rpcInvoke(sid, {namespace: namespace, service: service,
          method: method, args: [route, msg, groups[sid], opts]}, rpcCB(sid));
      }
    })();
  };

  var group;
  for(var sid in groups) {
    group = groups[sid];
    if(group && group.length > 0) {
      sendMessage(sid);
    } else {
      // empty group
      process.nextTick(rpcCB(sid));
    }
  }
};

var restoreChannel = function(self, cb) {
  if(!self.store) {
    utils.invokeCallback(cb);
    return;
  } else {
    //获取全局的通道存储情况
    loadAllFromStore(self, genKey(self), function(err, list) {
      if(!!err) {
        utils.invokeCallback(cb, err);
        return;
      } else {
        if(!list.length || !Array.isArray(list)) {
          utils.invokeCallback(cb);
          return;
        }
        var load = function(key) {
          return (function() {
            loadAllFromStore(self, key, function(err, items) {
              for(var j=0; j<items.length; j++) {
                var array = items[j].split(':');
                var sid = array[0]; //prefix??
                var uid = array[1];
                var channel = self.channels[name];
                //也就是本机知道所有uid的所在的serverId
                var res = add(uid, sid, channel.groups);
                if(res) {
                  channel.records[uid] = {sid: sid, uid: uid};
                }
              }
            });
          })();
        };

       for(var i=0; i<list.length; i++) {
        var name = list[i].slice(genKey(self).length + 1); //获取 self.prefix + ':' + self.app.serverId + ':' + name; 的name
        self.channels[name] = new Channel(name, self);
        load(list[i]);
      }
      utils.invokeCallback(cb);
    }
  });
}
};

var addToStore = function(self, key, value) {
  if(!!self.store) {
    //这里应该是个队列而不是键值对
    self.store.add(key, value, function(err) {
      if(!!err) {
        logger.error('add key: %s value: %s to store, with err: %j', key, value, err.stack);
      }
    });
  }
};

var removeFromStore = function(self, key, value) {
  if(!!self.store) {
    self.store.remove(key, value, function(err) {
      if(!!err) {
        logger.error('remove key: %s value: %s from store, with err: %j', key, value, err.stack);
      }
    });
  }
};

//获取通道里的所有成员
var loadAllFromStore = function(self, key, cb) {
  if(!!self.store) {
    self.store.load(key, function(err, list) {
      if(!!err) {
        logger.error('load key: %s from store, with err: %j', key, err.stack);
        utils.invokeCallback(cb, err);
      } else {
        utils.invokeCallback(cb, null, list);
      }
    });
  }
};

//删除通道里的所有成员
var removeAllFromStore = function(self, key) {
  if(!!self.store) {
    self.store.removeAll(key, function(err) {
      if(!!err) {
        logger.error('remove key: %s all members from store, with err: %j', key, err.stack);
      }
    });
  }
};

var genKey = function(self, name) {
  if(!!name) {
    return self.prefix + ':' + self.app.serverId + ':' + name; //通道队列里的值
  } else {
    return self.prefix + ':' + self.app.serverId; //通道队里的键
  }
};

var genValue = function(sid, uid) {
  return sid + ':' + uid;
};
