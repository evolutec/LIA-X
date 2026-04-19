// controller-launcher.js
// Simple Node.js service to start/restart llama-host-controller.ps1 on Windows.
// Usage: node controller-launcher.js
// Requires Node.js installed on Windows.

const http = require('http');
const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');

const CONTROLLER_SCRIPT = path.join(__dirname, 'llama-host-controller.ps1');
const LISTEN_PORT = 13580;
const CONTROLLER_PORT = 13579;
let controllerProcess = null;

function isWindows() {
  return os.platform() === 'win32';
}

function getPowerShellExecutable() {
  return new Promise((resolve, reject) => {
    execFile('where', ['pwsh.exe'], (err, stdout) => {
      if (!err && stdout) {
        return resolve(stdout.split(/\r?\n/)[0].trim());
      }
      execFile('where', ['powershell.exe'], (err2, stdout2) => {
        if (!err2 && stdout2) {
          return resolve(stdout2.split(/\r?\n/)[0].trim());
        }
        reject(new Error('Aucun interpréteur PowerShell trouvé.'));
      });
    });
  });
}

function startController() {
  if (!isWindows()) {
    return Promise.reject(new Error('Ce service doit être exécuté sur Windows.'));
  }
  if (controllerProcess && !controllerProcess.killed) {
    return Promise.resolve({ started: false, message: 'Contrôleur déjà démarré.' });
  }

  return getPowerShellExecutable().then((pwshPath) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CONTROLLER_SCRIPT];
    const child = spawn(pwshPath, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    controllerProcess = child;
    return { started: true, message: 'Contrôleur démarré.', pid: child.pid };
  });
}

function stopController() {
  if (!controllerProcess || controllerProcess.killed) {
    return Promise.resolve({ stopped: false, message: 'Aucun contrôleur actif trouvé.' });
  }
  try {
    process.kill(controllerProcess.pid);
    controllerProcess = null;
    return Promise.resolve({ stopped: true, message: 'Contrôleur arrêté.' });
  } catch (err) {
    return Promise.reject(err);
  }
}

function getHealth() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: CONTROLLER_PORT, path: '/status', method: 'GET', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          resolve({ ok: true, controller_ok: true, runtime: payload });
        } catch (err) {
          resolve({ ok: true, controller_ok: false, detail: 'Réponse invalide du contrôleur.' });
        }
      });
    });
    req.on('error', () => resolve({ ok: true, controller_ok: false, detail: 'Contrôleur introuvable.' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, controller_ok: false, detail: 'Timeout du contrôleur.' }); });
    req.end();
  });
}

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, await getHealth());
  }

  if (req.method === 'POST' && req.url === '/start') {
    try {
      const result = await startController();
      return sendJson(res, result);
    } catch (err) {
      return sendJson(res, { error: err.message }, 500);
    }
  }

  if (req.method === 'POST' && req.url === '/restart') {
    try {
      await stopController();
      const result = await startController();
      return sendJson(res, result);
    } catch (err) {
      return sendJson(res, { error: err.message }, 500);
    }
  }

  sendJson(res, { error: 'Route inconnue' }, 404);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`Controller launcher listening on http://127.0.0.1:${LISTEN_PORT}`);
});
