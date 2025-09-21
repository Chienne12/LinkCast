const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// rooms: { ABC123: { android: WebSocket|null, web: WebSocket|null } }
const rooms = Object.create(null);

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getPeer(sessionId, role) {
  const room = rooms[sessionId];
  if (!room) return null;
  return role === 'android' ? room.web : room.android;
}

function cleanup(ws) {
  if (!ws.sessionId || !ws.role) return;
  const room = rooms[ws.sessionId];
  if (!room) return;
  room[ws.role] = null;
  const peer = getPeer(ws.sessionId, ws.role);
  send(peer, { type: 'peer-left', sessionId: ws.sessionId, role: ws.role });
  if (!room.android && !room.web) {
    delete rooms[ws.sessionId];
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return send(ws, { type: 'error', message: 'Invalid JSON' });
    }

    const { type, sessionId, role } = msg;

    if (type === 'join') {
      if (!sessionId || !role || !['android', 'web'].includes(role)) {
        return send(ws, { type: 'error', message: 'join requires sessionId + role(android|web)' });
      }
      rooms[sessionId] = rooms[sessionId] || { android: null, web: null };
      const old = rooms[sessionId][role];
      if (old && old !== ws) {
        try { old.close(4001, 'replaced by new client'); } catch {}
      }
      rooms[sessionId][role] = ws;
      ws.sessionId = sessionId;
      ws.role = role;

      const peer = getPeer(sessionId, role);
      send(ws, { type: 'joined', sessionId, role, peerReady: !!peer });
      send(peer, { type: 'peer-joined', sessionId, role });
      return;
    }

    if (['offer', 'answer', 'ice', 'cmd'].includes(type)) {
      if (!ws.sessionId || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined yet' });
      }
      const peer = getPeer(ws.sessionId, ws.role);
      if (!peer) {
        return send(ws, { type: 'error', message: 'peer not available' });
      }
      return send(peer, msg);
    }

    return send(ws, { type: 'error', message: `unknown type: ${type}` });
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

// Heartbeat to terminate dead connections
setInterval(() => {
  wss.clients.forEach((client) => {
    if (!client.isAlive) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 30000);

console.log(`WS signaling server listening on ws://0.0.0.0:${PORT}`);
