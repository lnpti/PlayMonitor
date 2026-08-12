const { contextBridge, ipcRenderer } = require('electron');

// Ponte mínima e segura: a tela só consegue pedir uma leitura Modbus (host+porta+
// faixa de registros), nunca ganha acesso direto a Node/fs/rede. Tudo que sai daqui
// passa pelo main.js, que decide o que é permitido.
contextBridge.exposeInMainWorld('modbusAPI', {
  readAlarmPage: (host, port) => ipcRenderer.invoke('modbus-read-alarm-page', { host, port }),
  readGenerator: (host, port) => ipcRenderer.invoke('modbus-read-generator', { host, port }),
  sendGenControl: (host, port, action) => ipcRenderer.invoke('modbus-gen-control', { host, port, action }),
});

contextBridge.exposeInMainWorld('snmpAPI', {
  get: (host, port, community, oids) => ipcRenderer.invoke('snmp-get', { host, port, community, oids }),
});

contextBridge.exposeInMainWorld('updateAPI', {
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
});

contextBridge.exposeInMainWorld('notifyAPI', {
  sendEmail: (payload) => ipcRenderer.invoke('send-email', payload),
});
