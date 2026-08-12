const { app, BrowserWindow, Menu, shell, globalShortcut, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const { autoUpdater } = require('electron-updater');
const nodemailer = require('nodemailer');
const snmp = require('net-snmp');

let mainWindow = null;

// ── Alertas por e-mail (SMTP) ──
// Envio via main process porque SMTP não é HTTP — a tela não consegue fazer
// isso sozinha por fetch(). O servidor/credenciais vêm da própria tela
// (configurados pelo usuário), nunca ficam hardcoded aqui.
ipcMain.handle('send-email', async (event, { smtp, to, subject, text }) => {
  if (!smtp || !smtp.host) return { success: false, error: 'SMTP não configurado' };
  if (!Array.isArray(to) || !to.length) return { success: false, error: 'sem destinatários' };
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 587,
      secure: !!smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: to.join(','),
      subject,
      text,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// ── MODBUS TCP (Página 8 do GenComm — Condições de Alarme) ──
// Unit ID 0 confirmado por teste real contra um DSE855/6120 MKIII (unit id
// padrão 1 retorna "Illegal function" nesse equipamento).
// Implementação própria via net.Socket: a biblioteca modbus-serial se mostrou
// não-confiável especificamente dentro do Electron em modo app completo
// (falha com "Illegal function" mesmo com conexão TCP e unit id corretos);
// esta implementação bruta foi testada e funciona em todos os contextos.
const MODBUS_UNIT_ID = 0;
const MODBUS_TIMEOUT_MS = 4000;
const ALARM_PAGE_START = 2048; // pagina 8 * 256
const ALARM_PAGE_END = 2304;   // pagina 9 * 256 (exclusivo)
const MODBUS_CHUNK = 20;

let modbusTxId = 0;

function readHoldingRegisters(host, port, startAddr, quantity) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const txId = (modbusTxId = (modbusTxId + 1) & 0xffff);
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(val);
    };
    socket.setTimeout(MODBUS_TIMEOUT_MS);
    socket.on('timeout', () => finish(reject, new Error('timeout')));
    socket.on('error', (e) => finish(reject, e));
    socket.connect(port, host, () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(txId, 0);
      buf.writeUInt16BE(0, 2);
      buf.writeUInt16BE(6, 4);
      buf.writeUInt8(MODBUS_UNIT_ID, 6);
      buf.writeUInt8(3, 7); // function 3 = read holding registers
      buf.writeUInt16BE(startAddr, 8);
      buf.writeUInt16BE(quantity, 10);
      socket.write(buf);
    });
    socket.on('data', (data) => {
      const funcCode = data[7];
      if (funcCode & 0x80) {
        finish(reject, new Error('exception code ' + data[8]));
        return;
      }
      const byteCount = data[8];
      const regs = [];
      for (let i = 0; i < byteCount / 2; i++) regs.push(data.readUInt16BE(9 + i * 2));
      finish(resolve, regs);
    });
  });
}

// Cache do limite de registradores implementados por host:porta, pra não
// repetir a descoberta (várias conexões, halving) a cada ciclo de polling —
// só refaz se o dispositivo parar de responder no limite conhecido (reinício,
// firmware diferente, etc).
const alarmRangeCache = new Map();

async function readModbusAlarmPage(host, port) {
  const cacheKey = host + ':' + port;
  const cachedEnd = alarmRangeCache.get(cacheKey);
  if (cachedEnd != null) {
    try {
      const regs = await readHoldingRegisters(host, port, ALARM_PAGE_START, cachedEnd - ALARM_PAGE_START + 1);
      const registers = {};
      for (let i = 0; i < regs.length; i++) registers[ALARM_PAGE_START + i] = regs[i];
      return { success: true, registers };
    } catch (e) {
      alarmRangeCache.delete(cacheKey); // dispositivo mudou — refaz a descoberta abaixo
    }
  }

  // Nem todo controlador implementa a página 8 inteira (256 registradores) —
  // em testes reais, um DSE855/6120 MKIII só respondeu até o registrador 2080
  // e rejeitou (exception 1 / Illegal Function) qualquer leitura que
  // ultrapassasse esse limite, mesmo com endereço inicial válido, e mesmo
  // que o próprio endereço inicial fosse implementado. Por isso, quando um
  // bloco falha, tentamos de novo com metade do tamanho até achar exatamente
  // onde termina a faixa implementada (em vez de descartar tudo que sobrou).
  const registers = {};
  let start = ALARM_PAGE_START;
  let chunk = MODBUS_CHUNK;
  let firstError = null;
  while (start < ALARM_PAGE_END) {
    const len = Math.min(chunk, ALARM_PAGE_END - start);
    try {
      const regs = await readHoldingRegisters(host, port, start, len);
      for (let i = 0; i < regs.length; i++) registers[start + i] = regs[i];
      start += len;
      chunk = MODBUS_CHUNK;
    } catch (e) {
      if (firstError === null) firstError = e;
      if (len === 1) break; // este endereço não é implementado; para por aqui
      chunk = Math.max(1, Math.floor(len / 2));
    }
  }
  if (Object.keys(registers).length === 0) {
    return { success: false, error: (firstError && firstError.message) || String(firstError) };
  }
  alarmRangeCache.set(cacheKey, ALARM_PAGE_START + Object.keys(registers).length - 1);
  return { success: true, registers };
}

ipcMain.handle('modbus-read-alarm-page', async (event, { host, port }) => {
  if (!host || typeof host !== 'string') return { success: false, error: 'host inválido' };
  const p = Number(port) || 502;
  return readModbusAlarmPage(host, p);
});

// ── MODBUS TCP (Páginas 3, 4 e 7 — Status, Instrumentação Básica e
// Acumulada) — pra geradores sem módulo/API JSON (ex.: sem DSE855 web, só um
// gateway Modbus TCP direto no controlador). Endereços e escalas conferidos
// ao vivo contra um DSE855/6120 MKIII, batendo exatamente com os valores já
// exibidos pelo JSON (pressão de óleo, bateria, RPM, horas de funcionamento,
// partidas) — confirma também a ordem big-endian dos pares de 32 bits.
const GEN_PAGE3_START = 768;  // pagina 3 * 256 — status do grupo gerador
const GEN_PAGE3_LEN = 10;
const GEN_PAGE4_START = 1024; // pagina 4 * 256 — instrumentação básica
const GEN_PAGE4_LEN = 49;
const GEN_PAGE7_START = 1798; // pagina 7 * 256 + 6 — instrumentação acumulada (run time/partidas)
const GEN_PAGE7_LEN = 12;

async function readGenModbusFull(host, port) {
  try {
    const p3 = await readHoldingRegisters(host, port, GEN_PAGE3_START, GEN_PAGE3_LEN);
    const p4 = await readHoldingRegisters(host, port, GEN_PAGE4_START, GEN_PAGE4_LEN);
    const p7 = await readHoldingRegisters(host, port, GEN_PAGE7_START, GEN_PAGE7_LEN);
    const alarm = await readModbusAlarmPage(host, port);
    return { success: true, p3, p4, p7, alarm };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

ipcMain.handle('modbus-read-generator', async (event, { host, port }) => {
  if (!host || typeof host !== 'string') return { success: false, error: 'host inválido' };
  const p = Number(port) || 502;
  return readGenModbusFull(host, p);
});

// ── MODBUS TCP escrita (Página 16 — Registradores de Controle) ──
// Função 16 (write multiple registers): escreve uma "chave" de controle no
// registrador 8 e seu complemento de um (~key & 0xFFFF) no registrador 9,
// numa única mensagem — é assim que a GenComm define comandos remotos
// (Parar/Auto/Manual/Partida), documentado na SP-228 seção 8.17. Cada chave
// equivale a apertar o botão físico correspondente no controlador.
function writeMultipleRegisters(host, port, startAddr, values) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const txId = (modbusTxId = (modbusTxId + 1) & 0xffff);
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(val);
    };
    socket.setTimeout(MODBUS_TIMEOUT_MS);
    socket.on('timeout', () => finish(reject, new Error('timeout')));
    socket.on('error', (e) => finish(reject, e));
    socket.connect(port, host, () => {
      const byteCount = values.length * 2;
      const buf = Buffer.alloc(13 + byteCount);
      buf.writeUInt16BE(txId, 0);
      buf.writeUInt16BE(0, 2);
      buf.writeUInt16BE(7 + byteCount, 4);
      buf.writeUInt8(MODBUS_UNIT_ID, 6);
      buf.writeUInt8(16, 7); // function 16 = write multiple registers
      buf.writeUInt16BE(startAddr, 8);
      buf.writeUInt16BE(values.length, 10);
      buf.writeUInt8(byteCount, 12);
      values.forEach((v, i) => buf.writeUInt16BE(v & 0xFFFF, 13 + i * 2));
      socket.write(buf);
    });
    socket.on('data', (data) => {
      const funcCode = data[7];
      if (funcCode & 0x80) {
        finish(reject, new Error('exception code ' + data[8]));
        return;
      }
      finish(resolve, true);
    });
  });
}

const GEN_CONTROL_ADDR = 16 * 256 + 8; // pagina 16, registrador 8 (chave) + 9 (complemento)
const GEN_CONTROL_KEYS = {
  stop: 35700,   // Select Stop mode
  auto: 35701,   // Select Auto mode
  manual: 35702, // Select Manual mode
  start: 35705,  // Start engine (só funciona em modo Manual/Teste)
};

async function sendGenControl(host, port, action) {
  const key = GEN_CONTROL_KEYS[action];
  if (!key) return { success: false, error: 'ação inválida' };
  try {
    await writeMultipleRegisters(host, port, GEN_CONTROL_ADDR, [key, (~key) & 0xFFFF]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

ipcMain.handle('modbus-gen-control', async (event, { host, port, action }) => {
  if (!host || typeof host !== 'string') return { success: false, error: 'host inválido' };
  const p = Number(port) || 502;
  return sendGenControl(host, p, action);
});

// ── SNMP (transmissores Synteck RUS, MIB SINTECK-RUS-SNMP-MIB) ──
// Igual ao Modbus, SNMP é UDP puro — a tela não consegue fazer isso sozinha
// via fetch(). Usa a lib net-snmp (BER/ASN.1 é complexo demais pra valer a
// pena reimplementar à mão, diferente do framing simples do Modbus TCP).
// Alguns OIDs podem não existir em certos firmwares/modelos (confirmado ao
// vivo contra um transmissor real: 4 dos 24 OIDs voltaram "NoSuchObject") —
// por isso um OID individual faltando vira `null` no resultado, não faz o
// pedido inteiro falhar; só timeout/erro de sessão retorna success:false.
function snmpGet(host, port, community, oids) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; resolve(val); };
    let session;
    try {
      session = snmp.createSession(host, community || 'public', {
        port: Number(port) || 161,
        version: snmp.Version2c,
        timeout: 4000,
        retries: 1,
      });
    } catch (e) {
      finish({ success: false, error: e.message || String(e) });
      return;
    }
    session.on('error', (err) => {
      try { session.close(); } catch (e) {}
      finish({ success: false, error: (err && err.message) || String(err) });
    });
    session.get(oids, (error, varbinds) => {
      try { session.close(); } catch (e) {}
      if (error) { finish({ success: false, error: error.message || String(error) }); return; }
      const values = {};
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) { values[vb.oid] = null; continue; }
        let v = vb.value;
        if (Buffer.isBuffer(v)) v = v.toString('utf8');
        values[vb.oid] = v;
      }
      finish({ success: true, values });
    });
  });
}

ipcMain.handle('snmp-get', async (event, { host, port, community, oids }) => {
  if (!host || typeof host !== 'string') return { success: false, error: 'host inválido' };
  if (!Array.isArray(oids) || !oids.length) return { success: false, error: 'oids inválidos' };
  return snmpGet(host, port, community, oids);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    title: 'PlayMonitor — Painel de Monitoramento',
    icon: path.join(__dirname, 'PlayMonitor.png'),
    backgroundColor: '#060E1A',
    webPreferences: {
      webSecurity: false,       // permite fetch HTTP a partir de arquivo local (sem CORS)
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    show: false,                // evita flash branco na abertura
  });

  Menu.setApplicationMenu(null);

  // Limpa só o cache HTTP (nunca localStorage/config) antes de carregar —
  // sem isso, o Chromium às vezes serve uma cópia em cache do dashboard.html
  // mesmo depois de editado, mesmo reabrindo o app do zero.
  mainWindow.webContents.session.clearCache().finally(() => {
    mainWindow.loadFile('dashboard.html');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // links externos abrem no navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Atualização automática (GitHub Releases) ──
// Baixa a atualização em segundo plano assim que detecta uma versão nova
// publicada no repositório; só interrompe o uso pra perguntar quando o
// download termina (nunca reinicia sozinho, já que o app costuma ficar
// aberto monitorando 24h).
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Repassa o status pra tela poder mostrar feedback no botão "Verificar
// atualizações" — sem isso o processo todo fica invisível pro usuário.
function sendUpdateStatus(status, extra) {
  if (mainWindow) mainWindow.webContents.send('update-status', { status, ...extra });
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }));

autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', { version: info.version });
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Atualização disponível',
    message: `PlayMonitor ${info.version} foi baixado e está pronto pra instalar.`,
    detail: 'Reiniciar agora para aplicar, ou continuar usando — a atualização é aplicada sozinha na próxima vez que o app fechar.',
    buttons: ['Reiniciar agora', 'Depois'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('[autoUpdater] erro ao verificar/baixar atualização:', err.message);
  sendUpdateStatus('error', { message: err.message });
});

ipcMain.handle('check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);

  // Ctrl+Shift+I → DevTools
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  // Ctrl+R → recarregar
  globalShortcut.register('CommandOrControl+R', () => {
    if (mainWindow) mainWindow.webContents.reload();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
