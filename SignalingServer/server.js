const WebSocket = require('ws');
const PORT = process.env.PORT || 8082;
const wss = new WebSocket.Server({ 
    port: PORT,
    host: '0.0.0.0' // Bind tất cả interfaces để accept WiFi connections
});

// Room management system với mã bảo mật
const rooms = new Map(); // roomCode -> { android: WebSocket|null, web: WebSocket|null, createdAt: number, expiresAt: number, used: boolean }
const roomCleanupInterval = 30000; // 30 giây

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getPeer(roomCode, role) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  return role === 'android' ? room.web : room.android;
}

function cleanup(ws) {
  if (!ws.roomCode || !ws.role) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  room[ws.role] = null;
  const peer = getPeer(ws.roomCode, ws.role);
  send(peer, { type: 'peer-left', roomCode: ws.roomCode, role: ws.role });
  if (!room.android && !room.web) {
    rooms.delete(ws.roomCode);
  }
}

// Cleanup expired rooms
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [roomCode, room] of rooms.entries()) {
    if (now > room.expiresAt) {
      console.log(`Room ${roomCode} expired, cleaning up`);
      rooms.delete(roomCode);
    }
  }
}

// Start cleanup interval
setInterval(cleanupExpiredRooms, roomCleanupInterval);

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

    const { type, roomCode, role } = msg;

    // Tạo phòng mới (Web)
    if (type === 'create-room') {
      const { roomCode, createdAt, expiresAt } = msg;
      if (!roomCode || !createdAt || !expiresAt) {
        return send(ws, { type: 'error', message: 'create-room requires roomCode, createdAt, expiresAt' });
      }
      
      // Kiểm tra mã phòng đã tồn tại chưa
      if (rooms.has(roomCode)) {
        return send(ws, { type: 'error', message: 'Room code already exists' });
      }
      
      // Tạo phòng mới
      rooms.set(roomCode, {
        android: null,
        web: ws,
        createdAt: createdAt,
        expiresAt: expiresAt,
        used: false
      });
      
      ws.roomCode = roomCode;
      ws.role = 'web';
      
      send(ws, { type: 'room-created', roomCode: roomCode });
      console.log(`Room created: ${roomCode} by web client`);
      return;
    }

    // Join phòng (Android)
    if (type === 'join-room') {
      const { roomCode } = msg;
      if (!roomCode) {
        return send(ws, { type: 'error', message: 'join-room requires roomCode' });
      }
      
      const room = rooms.get(roomCode);
      if (!room) {
        return send(ws, { type: 'room-not-found', message: 'Room not found' });
      }
      
      // Kiểm tra mã hết hạn
      if (Date.now() > room.expiresAt) {
        rooms.delete(roomCode);
        return send(ws, { type: 'room-expired', message: 'Room has expired' });
      }
      
      // Kiểm tra mã đã dùng
      if (room.used) {
        return send(ws, { type: 'room-already-used', message: 'Room already used' });
      }
      
      // Kiểm tra web client có sẵn sàng không
      if (!room.web) {
        return send(ws, { type: 'room-not-ready', message: 'Web client not ready' });
      }
      
      // Kết nối Android vào phòng
      room.android = ws;
      room.used = true; // Đánh dấu đã dùng
      ws.roomCode = roomCode;
      ws.role = 'android';
      
      // Thông báo cho cả 2 client
      send(ws, { type: 'room-joined', roomCode: roomCode, peerReady: true });
      send(room.web, { type: 'peer-joined', roomCode: roomCode, role: 'android' });
      
      console.log(`Room joined: ${roomCode} by android client`);
      return;
    }

    // Xử lý WebRTC signaling
    if (['offer', 'answer', 'ice', 'cmd'].includes(type)) {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      const peer = getPeer(ws.roomCode, ws.role);
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

console.log(`WS signaling server listening on ws://0.0.0.0:${PORT} (WiFi mode with Room Management)`);
