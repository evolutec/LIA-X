const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3005/ws/voice');
let done = false;
ws.on('open', () => console.log('connecte'));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  console.log('recu: ' + JSON.stringify(m));
  if (m.type === 'ready') {
    // Silence pur : la VAD doit le rejeter, aucune transcription ne doit partir.
    const silence = new Float32Array(16000 * 2);
    ws.send(Buffer.from(silence.buffer));
    setTimeout(() => { console.log('fin du test silence'); ws.close(); process.exit(0); }, 3000);
  }
});
ws.on('error', (e) => { console.log('ERREUR: ' + e.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 12000);
