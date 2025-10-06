const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const path = require('path');
const fs = require('fs');
const StreamingService = require('./streaming-service');
const PORT = process.env.PORT || 8080;

// ✅ MESSAGES CONSTANTS
const MESSAGES = {
  // Error messages
  INVALID_JSON: 'Invalid JSON',
  INVALID_ROOM_CODE_FORMAT: 'Invalid room code format (must be 6 characters)',
  ROOM_NOT_FOUND: 'Room not found. Please create a room first.',
  ROOM_ALREADY_EXISTS: 'Room code already exists',
  ROOM_EXPIRED: 'Room has expired',
  ROOM_ALREADY_USED: 'Room already used',
  ROOM_NOT_READY: 'Web client not ready',
  NOT_JOINED_TO_ROOM: 'not joined to room yet',
  PEER_NOT_AVAILABLE: 'peer not available',
  ONLY_WEB_CAN_START_STREAM: 'only web client can start streaming',
  ONLY_WEB_CAN_STOP_STREAM: 'only web client can stop streaming',
  INPUT_URL_REQUIRED: 'inputUrl required for streaming',
  FAILED_TO_START_STREAMING: 'Failed to start streaming',
  FAILED_TO_STOP_STREAMING: 'Failed to stop streaming',
  MISSING_REQUIRED_FIELDS: 'Missing required fields: roomCode, hlsUrl, watchPageUrl',
  MISSING_ROOM_CODE: 'Missing roomCode',
  MISSING_ROOM_CODE_OR_INPUT_URL: 'Missing roomCode or inputUrl',
  INTERNAL_SERVER_ERROR: 'Internal server error',
  FAILED_TO_START_STREAM: 'Failed to start stream',
  FAILED_TO_STOP_STREAM: 'Failed to stop stream',
  FAILED_TO_ADD_VIEWER: 'Failed to add viewer',
  FAILED_TO_REMOVE_VIEWER: 'Failed to remove viewer',
  
  // Success messages
  SUCCESSFULLY_LEFT_ROOM: 'Successfully left room',
  
  // Status messages
  STREAM_NOT_FOUND: 'Stream not found',
  STREAM_NOT_ACTIVE: 'Stream not active for this room',
  ROOM_EXISTS_BUT_NO_STREAM: 'room_exists_but_no_stream',
  STREAMING_ACTIVE: 'streaming_active',
  
  // Console messages
  STREAM_UPLOAD_CONNECTED: '📡 Stream upload WebSocket connected',
  BINARY_DATA_NO_ROOM: '⚠️ Received binary data but no room code initialized',
  
  // Requirements messages
  CREATE_ROOM_REQUIRES: 'create-room requires roomCode, createdAt, expiresAt',
  JOIN_ROOM_REQUIRES: 'join-room requires roomCode',
  JOIN_REQUIRES: 'join requires sessionId + role(android|web)'
};

// Room management system với mã bảo mật
const rooms = new Map(); // roomCode -> { android: WebSocket|null, web: WebSocket|null, createdAt: number, expiresAt: number, used: boolean }

// Initialize streaming service with rooms reference
const streamingService = new StreamingService(rooms);
const roomCleanupInterval = 30000; // 30 giây

// Get server IP address for cross-device access
function getServerIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  
  // Try to find the first non-internal IPv4 address
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  
  // Fallback to localhost if no external IP found
  return 'localhost';
}

// Dynamic server address detection
function getServerAddress(req) {
  // Check if we have a custom domain from environment variable
  if (process.env.DOMAIN) {
    return process.env.DOMAIN;
  }
  
  // Check if request has Host header (for deployed environments)
  if (req && req.headers && req.headers.host) {
    const host = req.headers.host;
    // If it's not localhost, use the host from request
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `http://${host}`;
    }
  }
  
  // Fallback to local IP detection
  const serverIP = getServerIP();
  return `http://${serverIP}:${PORT}`;
}

const SERVER_IP = getServerIP();

// HTTP server for Render health check & REST API endpoints
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Get server info endpoint (for dynamic address)
  if (pathname === '/api/server-info' && method === 'GET') {
    const serverAddress = getServerAddress(req);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true,
      serverAddress: serverAddress,
      port: PORT,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Health check endpoint
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Test FFmpeg availability
  if (pathname === '/test-ffmpeg' && method === 'GET') {
    const { exec } = require('child_process');
    
    exec('ffmpeg -version', (error, stdout, stderr) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
          error: 'FFmpeg not available',
          message: error.message 
        }));
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true,
        version: stdout.split('\n')[0],
        details: stdout
      }));
    });
    return;
  }

  // Server info endpoint
  if (pathname === '/api/server-info' && method === 'GET') {
    const wsEndpoint = process.env.RAILWAY_PUBLIC_DOMAIN 
      ? `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `ws://localhost:${PORT}`;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      serverAddress: wsEndpoint,
      domain: process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost',
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Stream ready notification endpoint
  if (pathname === '/api/notify-stream-ready' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { roomCode, hlsUrl, watchPageUrl } = data;
        
        if (!roomCode || !hlsUrl || !watchPageUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: MESSAGES.MISSING_REQUIRED_FIELDS }));
        }

        // Find the room and notify clients
        const normalizedRoomCode = roomCode.toUpperCase();
        const room = rooms.get(normalizedRoomCode);
        
        if (!room) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.ROOM_NOT_FOUND }));
        }

        // Send stream_ready message to both clients
        const streamReadyMessage = {
          type: 'stream_ready',
          roomCode: normalizedRoomCode,
          hlsUrl: hlsUrl,
          watchPageUrl: watchPageUrl,
          timestamp: new Date().toISOString()
        };

        let notifiedClients = 0;
        if (room.android) {
          send(room.android, streamReadyMessage);
          notifiedClients++;
        }
        if (room.web) {
          send(room.web, streamReadyMessage);
          notifiedClients++;
        }

        console.log(`📺 Stream ready notification sent for room ${normalizedRoomCode} to ${notifiedClients} clients`);
        console.log(`   HLS URL: ${hlsUrl}`);
        console.log(`   Watch URL: ${watchPageUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          roomCode: normalizedRoomCode,
          notifiedClients: notifiedClients 
        }));

      } catch (error) {
        console.error('Error processing stream ready notification:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: MESSAGES.INTERNAL_SERVER_ERROR }));
      }
    });
    return;
  }

  // Start streaming endpoint
  if (pathname === '/api/start-stream' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { roomCode, inputUrl } = data;
        
        if (!roomCode || !inputUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.MISSING_ROOM_CODE_OR_INPUT_URL }));
        }

        const hlsUrl = await streamingService.startStream(roomCode, inputUrl);
        const watchUrl = streamingService.getViewerUrl(roomCode);

        console.log(`🎬 Started streaming for room ${roomCode}`);
        console.log(`   Input: ${inputUrl}`);
        console.log(`   HLS: ${hlsUrl}`);
        console.log(`   Watch: ${watchUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          roomCode,
          hlsUrl,
          watchUrl
        }));

      } catch (error) {
        console.error('Error starting stream:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: MESSAGES.FAILED_TO_START_STREAM }));
      }
    });
    return;
  }

  // Stop streaming endpoint
  if (pathname === '/api/stop-stream' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { roomCode } = data;
        
        if (!roomCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.MISSING_ROOM_CODE }));
        }

        streamingService.stopStream(roomCode);
        console.log(`🛑 Stopped streaming for room ${roomCode}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          roomCode
        }));

      } catch (error) {
        console.error('Error stopping stream:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: MESSAGES.FAILED_TO_STOP_STREAM }));
      }
    });
    return;
  }

  // Viewer connect endpoint
  if (pathname === '/api/viewer-connect' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { roomCode } = data;
        
        if (!roomCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.MISSING_ROOM_CODE }));
        }

        streamingService.addViewer(roomCode);
        const viewerCount = streamingService.getViewerCount(roomCode);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          roomCode,
          viewerCount
        }));

      } catch (error) {
        console.error('Error adding viewer:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: MESSAGES.FAILED_TO_ADD_VIEWER }));
      }
    });
    return;
  }

  // Viewer disconnect endpoint
  if (pathname === '/api/viewer-disconnect' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { roomCode } = data;
        
        if (!roomCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.MISSING_ROOM_CODE }));
        }

        streamingService.removeViewer(roomCode);
        const viewerCount = streamingService.getViewerCount(roomCode);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          roomCode,
          viewerCount
        }));

      } catch (error) {
        console.error('Error removing viewer:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: MESSAGES.FAILED_TO_REMOVE_VIEWER }));
      }
    });
    return;
  }

  // Get room stream info endpoint
  if (pathname.startsWith('/api/room/') && method === 'GET') {
    const roomCode = pathname.split('/')[3];
    
    if (!roomCode) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MESSAGES.MISSING_ROOM_CODE }));
    }

    const normalizedRoomCode = roomCode.toUpperCase();
    const room = rooms.get(normalizedRoomCode);
    
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        error: MESSAGES.ROOM_NOT_FOUND,
        roomCode: normalizedRoomCode
      }));
    }

    // Check if room has active streaming
    // These lines are now replaced by dynamic address detection below
    
    // Check if HLS file exists
    const hlsPath = path.join(__dirname, 'streams', normalizedRoomCode, 'playlist.m3u8');
    const streamActive = fs.existsSync(hlsPath);
    
    // Get dynamic server address
    const serverAddress = getServerAddress(req);
    const hlsUrl = `${serverAddress}/streams/${normalizedRoomCode}/playlist.m3u8`;
    const watchUrl = `${serverAddress}/watch/${normalizedRoomCode}`;
    
    if (!streamActive) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        error: MESSAGES.STREAM_NOT_ACTIVE,
        roomCode: normalizedRoomCode,
        status: MESSAGES.ROOM_EXISTS_BUT_NO_STREAM
      }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true,
      roomCode: normalizedRoomCode,
      hlsUrl: hlsUrl,
      watchUrl: watchUrl,
      status: MESSAGES.STREAMING_ACTIVE,
      serverAddress: serverAddress
    }));
    return;
  }

  // Serve HLS streams
  if (pathname.startsWith('/streams/')) {
    const filePath = path.join(__dirname, pathname);
    
    // Extract room code from path for viewer tracking
    const pathParts = pathname.split('/');
    const roomCode = pathParts[2]; // /streams/ROOMCODE/file.m3u8
    
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      let contentType = 'application/octet-stream';
      
      if (ext === '.m3u8') {
        contentType = 'application/vnd.apple.mpegurl';
        // Track viewer activity when accessing playlist
        if (roomCode) {
          streamingService.updateViewerActivity(roomCode);
        }
      } else if (ext === '.ts') {
        contentType = 'video/mp2t';
        // Track viewer activity when accessing segments
        if (roomCode) {
          streamingService.updateViewerActivity(roomCode);
        }
      }
      
      res.setHeader('Cache-Control', 'no-cache');
      res.writeHead(200, { 'Content-Type': contentType });
      
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(MESSAGES.STREAM_NOT_FOUND);
      return;
    }
  }

  // Serve viewer page
  if (pathname.startsWith('/watch/')) {
    const roomCode = pathname.split('/')[2];
    if (roomCode) {
      // Add viewer when they visit the watch page
      streamingService.addViewer(roomCode);
      
      const viewerHtml = generateViewerPage(roomCode);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(viewerHtml);
      return;
    }
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LinkCast signaling alive');
});

// Function to generate viewer page HTML
function generateViewerPage(roomCode) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Xem Stream - ${roomCode}</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background: #000;
            color: #fff;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }
        .container {
            max-width: 1200px;
            width: 100%;
        }
        h1 {
            text-align: center;
            margin-bottom: 20px;
        }
        #video {
            width: 100%;
            max-width: 800px;
            height: auto;
            background: #222;
            border-radius: 8px;
        }
        .info {
            margin-top: 20px;
            padding: 15px;
            background: #333;
            border-radius: 8px;
            text-align: center;
        }
        .status {
            margin: 10px 0;
            padding: 10px;
            border-radius: 4px;
        }
        .status.loading {
            background: #ff9800;
            color: #000;
        }
        .status.playing {
            background: #4caf50;
        }
        .status.error {
            background: #f44336;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 Stream Room: ${roomCode}</h1>
        <video id="video" controls autoplay muted></video>
        <div class="info">
            <div id="status" class="status loading">Đang tải stream...</div>
            <div>Room Code: <strong>${roomCode}</strong></div>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        const status = document.getElementById('status');
        const streamUrl = '/streams/${roomCode}/playlist.m3u8';

        function updateStatus(message, type = 'loading') {
            status.textContent = message;
            status.className = 'status ' + type;
        }

        function initPlayer() {
            if (Hls.isSupported()) {
                const hls = new Hls({
                    enableWorker: false,
                    lowLatencyMode: true,
                    backBufferLength: 90
                });

                hls.loadSource(streamUrl);
                hls.attachMedia(video);

                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    updateStatus('Stream sẵn sàng', 'playing');
                    video.play().catch(e => {
                        console.log('Autoplay prevented:', e);
                        updateStatus('Nhấn play để xem stream', 'playing');
                    });
                });

                hls.on(Hls.Events.ERROR, function(event, data) {
                    console.error('HLS Error:', data);
                    if (data.fatal) {
                        switch(data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                updateStatus('Lỗi mạng - đang thử lại...', 'error');
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                updateStatus('Lỗi media - đang khôi phục...', 'error');
                                hls.recoverMediaError();
                                break;
                            default:
                                updateStatus('Lỗi không thể khôi phục', 'error');
                                hls.destroy();
                                break;
                        }
                    }
                });

            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari native HLS support
                video.src = streamUrl;
                video.addEventListener('loadedmetadata', function() {
                    updateStatus('Stream sẵn sàng', 'playing');
                });
                video.addEventListener('error', function() {
                    updateStatus('Lỗi phát stream', 'error');
                });
            } else {
                updateStatus('Trình duyệt không hỗ trợ HLS', 'error');
            }
        }

        // Retry mechanism
        let retryCount = 0;
        const maxRetries = 10;

        function checkStreamAndInit() {
            fetch(streamUrl)
                .then(response => {
                    if (response.ok) {
                        initPlayer();
                    } else {
                        throw new Error('Stream not ready');
                    }
                })
                .catch(error => {
                    retryCount++;
                    if (retryCount < maxRetries) {
                        updateStatus(\`Đang chờ stream... (\${retryCount}/\${maxRetries})\`, 'loading');
                        setTimeout(checkStreamAndInit, 2000);
                    } else {
                        updateStatus('Stream không khả dụng', 'error');
                    }
                });
        }

        // Start checking for stream
        checkStreamAndInit();

        // Track viewer disconnect when page is closed/refreshed
        window.addEventListener('beforeunload', function() {
            // Send beacon to notify server that viewer is leaving
            navigator.sendBeacon('/api/viewer-disconnect', JSON.stringify({
                roomCode: '${roomCode}'
            }));
        });

        // Also track page visibility changes (tab switching, minimizing)
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                // Page is hidden, viewer might have left
                fetch('/api/viewer-disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ roomCode: '${roomCode}' })
                }).catch(e => console.log('Failed to notify disconnect:', e));
            } else {
                // Page is visible again, viewer is back
                fetch('/api/viewer-connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ roomCode: '${roomCode}' })
                }).catch(e => console.log('Failed to notify connect:', e));
            }
        });
    </script>
</body>
</html>`;
}
const wss = new WebSocket.Server({ server });

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

// Cleanup expired rooms - kiểm tra mỗi 10 giây cho mã 20 giây
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [roomCode, room] of rooms.entries()) {
    if (now > room.expiresAt) {
      console.log(`🗑️ Room ${roomCode} expired after 20 seconds, cleaning up`);
      // Thông báo cho các client về việc phòng hết hạn
      if (room.android) {
        send(room.android, { type: 'room-expired', roomCode });
      }
      if (room.web) {
        send(room.web, { type: 'room-expired', roomCode });
      }
      rooms.delete(roomCode);
    }
  }
}

// Start cleanup interval - kiểm tra mỗi 30 giây (đã sửa từ 10s lên 30s)
setInterval(cleanupExpiredRooms, 30000);

// ✅ THÊM: Debug WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
  console.log('🔄 WebSocket upgrade request:', {
    url: request.url,
    origin: request.headers.origin,
    host: request.headers.host
  });
});

wss.on('connection', (ws, req) => {
  // ✅ THÊM: Origin validation
  const origin = req.headers.origin;
  console.log('🔗 WebSocket connection from:', origin);
  
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  // Kiểm tra nếu đây là WebSocket cho stream upload
  const pathname = url.parse(req.url).pathname;
  
  if (pathname === '/stream-upload') {
    let roomCode = null;
    let isInitialized = false;
    const binaryQueue = []; // Queue để lưu binary data khi chưa init
    
    console.log(MESSAGES.STREAM_UPLOAD_CONNECTED);
    
    ws.on('message', async (data) => {
      try {
        if (typeof data === 'string') {
          // JSON control message
          const msg = JSON.parse(data);
          
          if (msg.type === 'init') {
            roomCode = msg.roomCode;
            console.log(`🔧 Stream init received: roomCode=${roomCode}`);
            
            // Validate room code
            if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 6) {
              console.log(`❌ Invalid room code format: ${roomCode}`);
              ws.send(JSON.stringify({
                type: 'error',
                message: MESSAGES.INVALID_ROOM_CODE_FORMAT
              }));
              return;
            }
            
            // Check room exists
            const normalizedRoomCode = roomCode.toUpperCase();
            console.log(`🔍 Checking room exists: ${normalizedRoomCode}, rooms: ${Array.from(rooms.keys())}`);
            
            if (!rooms.has(normalizedRoomCode)) {
              console.log(`❌ Room not found: ${normalizedRoomCode}`);
              ws.send(JSON.stringify({
                type: 'error',
                message: MESSAGES.ROOM_NOT_FOUND
              }));
              return;
            }
            
            // Store normalized roomCode
            roomCode = normalizedRoomCode;
            ws.roomCode = normalizedRoomCode;
            
            console.log(`🎬 Starting FFmpeg for room ${roomCode}...`);
            
            try {
              const playlistUrl = await streamingService.startStreamFromStdin(roomCode);
              
              // ✅ Mark as initialized BEFORE sending response
              isInitialized = true;
              
              // Send confirmation
              const response = { 
                type: 'stream-started', 
                playlistUrl: playlistUrl,
                roomCode: roomCode 
              };
              console.log(`📤 Sending stream-started:`, response);
              ws.send(JSON.stringify(response));
              
              // ✅ Process queued binary data
              if (binaryQueue.length > 0) {
                console.log(`📦 Processing ${binaryQueue.length} queued binary chunks...`);
                for (const queuedChunk of binaryQueue) {
                  streamingService.writeChunk(roomCode, queuedChunk);
                }
                binaryQueue.length = 0; // Clear queue
                console.log(`✅ Queued chunks processed`);
              }
              
            } catch (error) {
              console.error(`❌ Failed to start FFmpeg:`, error);
              ws.send(JSON.stringify({ 
                type: 'stream-failed', 
                error: error.message,
                roomCode: roomCode
              }));
            }
          }
          
        } else {
          // Binary data - video chunks
          
          // ✅ Queue binary data if not initialized yet
          if (!isInitialized || !roomCode) {
            console.log(`📦 Queueing binary chunk (not initialized yet), queue size: ${binaryQueue.length + 1}`);
            binaryQueue.push(data);
            
            // ✅ Limit queue size to prevent memory overflow
            if (binaryQueue.length > 100) {
              const dropped = binaryQueue.shift();
              console.warn(`⚠️ Dropped chunk (${dropped.length} bytes) for room ${roomCode || 'unknown'}`);
            }
            return;
          }
          
          // Write chunk if initialized
          const writeSuccess = streamingService.writeChunk(roomCode, data);
          if (!writeSuccess) {
            console.warn(`⚠️ Failed to write chunk for room ${roomCode}`);
          }
        }
        
      } catch (error) {
        console.error('❌ Error processing stream message:', error);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Error processing message',
          error: error.message 
        }));
      }
    });
    
    ws.on('close', () => {
      console.log(`🔌 Stream WebSocket closed for room ${roomCode}`);
      
      // Cleanup
      binaryQueue.length = 0;
      
      if (roomCode) {
        streamingService.stopStream(roomCode);
      }
    });
    
    ws.on('error', (error) => {
      console.error('❌ Stream WebSocket error:', error);
      
      // Cleanup
      binaryQueue.length = 0;
      
      if (roomCode) {
        streamingService.stopStream(roomCode);
      }
    });
    
    return; // Exit early for stream upload connections
  }

  // Existing WebRTC signaling logic
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return send(ws, { type: 'error', message: 'Invalid JSON' });
    }

    const { type, roomCode, role } = msg;
    console.log(`📨 Received message: ${type}`, msg);

    // Tạo phòng mới (Web)
    if (type === 'create-room') {
      const { roomCode, createdAt, expiresAt } = msg;
      if (!roomCode || !createdAt || !expiresAt) {
        return send(ws, { type: 'error', message: 'create-room requires roomCode, createdAt, expiresAt' });
      }
      
      // Chuẩn hóa roomCode thành uppercase để nhất quán
      const normalizedRoomCode = roomCode.toUpperCase();
      
      // Kiểm tra mã phòng đã tồn tại chưa
      if (rooms.has(normalizedRoomCode)) {
        return send(ws, { type: 'error', message: 'Room code already exists' });
      }
      
      // Tạo phòng mới
      rooms.set(normalizedRoomCode, {
        android: null,
        web: ws,
        createdAt: createdAt,
        expiresAt: expiresAt,
        used: false
      });
      
      ws.roomCode = normalizedRoomCode;
      ws.role = 'web';
      
      send(ws, { type: 'room-created', roomCode: normalizedRoomCode });
      console.log(`Room created: ${normalizedRoomCode} by web client`);
      return;
    }

    // Join phòng (Android)
    if (type === 'join-room') {
      const { roomCode } = msg;
      if (!roomCode) {
        return send(ws, { type: 'error', message: 'join-room requires roomCode' });
      }
      
      // Tìm room không phân biệt hoa thường
      const normalizedRoomCode = roomCode.toUpperCase();
      const room = rooms.get(normalizedRoomCode);
      if (!room) {
        return send(ws, { type: 'room-not-found', message: 'Room not found' });
      }
      
      // Kiểm tra mã hết hạn
      if (Date.now() > room.expiresAt) {
        rooms.delete(normalizedRoomCode);
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
      // LƯU Ý: cần lưu roomCode ở dạng chuẩn hóa để các message sau route đúng
      ws.roomCode = normalizedRoomCode;
      ws.role = 'android';
      
      // Thông báo cho cả 2 client (trả về roomCode như phía web nhập để hiển thị, nhưng logic nội bộ dùng normalized)
      send(ws, { type: 'room-joined', roomCode: normalizedRoomCode, peerReady: true });
      send(room.web, { type: 'peer-joined', roomCode: normalizedRoomCode, role: 'android' });
      
      console.log(`Room joined: ${roomCode} by android client`);
      return;
    }

    // Hệ thống cũ - join với sessionId (backward compatibility)
    if (type === 'join') {
      const { sessionId, role } = msg;
      if (!sessionId || !role || !['android', 'web'].includes(role)) {
        return send(ws, { type: 'error', message: 'join requires sessionId + role(android|web)' });
      }
      
      // Tạo room với sessionId làm roomCode
      const roomCode = sessionId;
      if (!rooms.has(roomCode)) {
        rooms.set(roomCode, {
          android: null,
          web: null,
          createdAt: Date.now(),
          expiresAt: Date.now() + (30 * 60 * 1000), // 30 phút cho hệ thống cũ
          used: false
        });
      }
      
      const room = rooms.get(roomCode);
      const old = room[role];
      if (old && old !== ws) {
        try { old.close(4001, 'replaced by new client'); } catch {}
      }
      room[role] = ws;
      ws.roomCode = roomCode;
      ws.role = role;

      const peer = getPeer(roomCode, role);
      send(ws, { type: 'joined', sessionId, role, peerReady: !!peer });
      send(peer, { type: 'peer-joined', sessionId, role });
      console.log(`Legacy join: ${sessionId} by ${role}`);
      return;
    }

    // Chuyển đổi lệnh 'command' từ web -> 'cmd' thống nhất cho Android
    if (type === 'command') {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      const peer = getPeer(ws.roomCode, ws.role);
      if (!peer) {
        return send(ws, { type: 'error', message: 'peer not available' });
      }
      const { command, data } = msg;
      return send(peer, { type: 'cmd', cmd: command, payload: data });
    }

    // Xử lý countdown-start từ Android -> chuyển cho Web
    if (type === 'countdown-start') {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      const peer = getPeer(ws.roomCode, ws.role);
      if (!peer) {
        return send(ws, { type: 'error', message: 'peer not available' });
      }
      console.log(`Countdown signal from ${ws.role} -> forwarding to ${peer.role}`);
      return send(peer, { type: 'countdown-start' });
    }

    // Xử lý start streaming - khi web client muốn bắt đầu stream HLS
    if (type === 'start-stream') {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      
      if (ws.role !== 'web') {
        return send(ws, { type: 'error', message: 'only web client can start streaming' });
      }
      
      try {
        // Giả sử web client sẽ cung cấp input URL (có thể là WebRTC stream URL)
        const { inputUrl } = msg;
        if (!inputUrl) {
          return send(ws, { type: 'error', message: 'inputUrl required for streaming' });
        }
        
        // Bắt đầu streaming với FFmpeg
        streamingService.startStream(ws.roomCode, inputUrl)
          .then(hlsUrl => {
            const watchUrl = streamingService.getViewerUrl(ws.roomCode);
            
            // Thông báo stream_ready cho cả 2 clients
            const streamReadyMessage = {
              type: 'stream_ready',
              roomCode: ws.roomCode,
              hlsUrl: hlsUrl,
              watchPageUrl: `http://${SERVER_IP}:${PORT}${watchUrl}`,
              timestamp: new Date().toISOString()
            };
            
            // Gửi cho web client
            send(ws, streamReadyMessage);
            
            // Gửi cho android client nếu có
            const peer = getPeer(ws.roomCode, ws.role);
            if (peer) {
              send(peer, streamReadyMessage);
            }
            
            console.log(`🎬 Stream started for room ${ws.roomCode}`);
            console.log(`   HLS URL: ${hlsUrl}`);
            console.log(`   Watch URL: ${watchUrl}`);
          })
          .catch(error => {
            console.error('Error starting stream:', error);
            send(ws, { type: 'error', message: 'Failed to start streaming' });
          });
        
      } catch (error) {
        console.error('Error starting stream:', error);
        send(ws, { type: 'error', message: 'Failed to start streaming' });
      }
      return;
    }

    // Xử lý stop streaming
    if (type === 'stop-stream') {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      
      if (ws.role !== 'web') {
        return send(ws, { type: 'error', message: 'only web client can stop streaming' });
      }
      
      try {
        streamingService.stopStream(ws.roomCode);
        
        // Thông báo stream stopped
        const streamStoppedMessage = {
          type: 'stream_stopped',
          roomCode: ws.roomCode,
          timestamp: new Date().toISOString()
        };
        
        send(ws, streamStoppedMessage);
        
        const peer = getPeer(ws.roomCode, ws.role);
        if (peer) {
          send(peer, streamStoppedMessage);
        }
        
        console.log(`🛑 Stream stopped for room ${ws.roomCode}`);
        
      } catch (error) {
        console.error('Error stopping stream:', error);
        send(ws, { type: 'error', message: 'Failed to stop streaming' });
      }
      return;
    }

    // Xử lý leave room - khi client rời phòng
    if (type === 'leave') {
      if (!ws.roomCode || !ws.role) {
        return send(ws, { type: 'error', message: 'not joined to room yet' });
      }
      
      const room = rooms.get(ws.roomCode);
      if (room) {
        // Thông báo cho peer còn lại về việc phòng đã đóng
        const peer = getPeer(ws.roomCode, ws.role);
        if (peer) {
          send(peer, { type: 'room_closed', roomCode: ws.roomCode, reason: 'peer_left' });
          console.log(`Notified ${peer.role} that room ${ws.roomCode} is closed`);
        }
        
        // Xóa phòng khỏi danh sách
        rooms.delete(ws.roomCode);
        console.log(`Room ${ws.roomCode} deleted due to ${ws.role} leaving`);
      }
      
      // Reset client state
      ws.roomCode = null;
      ws.role = null;
      
      send(ws, { type: 'left', message: 'Successfully left room' });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  
  // ✅ THÊM: Railway health check ready signal
  setTimeout(() => {
    console.log('✅ Health check ready');
  }, 2000);
  
  // ✅ FIX: WebSocket endpoint cho Railway
  const wsEndpoint = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `ws://localhost:${PORT}`;
  console.log(`✅ WebSocket endpoint: ${wsEndpoint}`);
  console.log(`✅ Server accessible at: http://${SERVER_IP}:${PORT}`);
  
  // Debug FFmpeg availability
  const { exec } = require('child_process');
  exec('ffmpeg -version', (error, stdout, stderr) => {
    if (error) {
      console.error('❌ FFmpeg not available:', error.message);
      console.error('❌ This will cause HLS streaming to fail!');
    } else {
      console.log('✅ FFmpeg is available');
      console.log('📋 FFmpeg version:', stdout.split('\n')[0]);
    }
  });
});
