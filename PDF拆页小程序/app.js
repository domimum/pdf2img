App({
  globalData: {
    appName: 'PDF存图助手',
    cloudReady: false,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    try {
      // 不写死环境名：自动使用当前小程序的默认云环境
      wx.cloud.init({ traceUser: true });
      this.globalData.cloudReady = true;
      console.log('云开发初始化成功');
    } catch (e) {
      console.error('云开发初始化失败', e);
      this.globalData.cloudReady = false;
    }
  },
});
