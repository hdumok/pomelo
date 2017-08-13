var ChannelService = require('../common/service/channelService');

//通道组件就直接把service实例当组件实例返回了
module.exports = function(app, opts) {
  var service = new ChannelService(app, opts);
  app.set('channelService', service, true);
  service.name = '__channel__';
  return service;
};