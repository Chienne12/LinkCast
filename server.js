const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;

// Store rooms and participants
const rooms = new Map();
const participants = new Map();

// HTTP server for API endpoints
const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;
    
    console.log(`${method} ${path}`);
    
    // Route handling
    if (path === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        }));
    }
    else if (path === '/api/test-connection' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'connected',
            server: 'QuickCast Pro',
            timestamp: new Date().toISOString()
        }));
    }
    else if (path === '/api/room/create' && method === 'POST') {
        handleCreateRoom(req, res);
    }
    else if (path === '/api/stream/start' && method === 'POST') {
        handleStreamStart(req, res);
    }
    else if (path === '/api/stream/stop' && method === 'POST') {
        handleStreamStop(req, res);
    }
    else if (path === '/api/rooms' && method === 'GET') {
        handleGetRooms(req, res);
    }
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Endpoint not found',
            path: path,
            method: method
        }));
    }
});

// Handle room creation
function handleCreateRoom(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        try {
            const data = JSON.parse(body || '{}');
            const roomCode = generateRoomCode();
            const roomId = uuidv4();
            
            const room = {
                id: roomId,
                code: roomCode,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
                participants: [],
                status: 'active'
            };
            
            rooms.set(roomId, room);
            
            console.log(`Room created: ${roomCode} (${roomId})`);
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                room: room,
                roomCode: roomCode
            }));
        } catch (error) {
            console.error('Error creating room:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to create room'
            }));
        }
    });
}

// Handle stream start
function handleStreamStart(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        try {
            const data = JSON.parse(body || '{}');
            const { roomCode, streamType, quality } = data;
            
            // Find room by code
            let room = null;
            for (const [roomId, r] of rooms.entries()) {
                if (r.code === roomCode) {
                    room = r;
                    break;
                }
            }
            
            if (!room) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Room not found'
                }));
                return;
            }
            
            // Update room with stream info
            room.stream = {
                type: streamType || 'screen',
                quality: quality || 'auto',
                startedAt: new Date().toISOString(),
                status: 'active'
            };
            
            const forwardedProto = req.headers['x-forwarded-proto'];
            const isSecure = (forwardedProto && forwardedProto.includes('https')) || req.connection.encrypted;
            const protocol = isSecure ? 'https' : 'http';
            const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).toString().split(',')[0].trim();
            const baseHost = hostHeader.replace(/^https?:\/\//, '');
            const publicWatchUrl = `${protocol}://${baseHost}/watch/${roomCode}`;

            const manualRtmpBase = process.env.RTMP_BASE_URL ? process.env.RTMP_BASE_URL.replace(/\/$/, '') : null;
            const inferredRtmpHost = baseHost.split(':')[0];
            const rtmpUrl = manualRtmpBase
                ? `${manualRtmpBase}/${roomCode}`
                : `rtmp://${inferredRtmpHost}/live/${roomCode}`;

            const manualHlsBase = process.env.HLS_BASE_URL ? process.env.HLS_BASE_URL.replace(/\/$/, '') : null;
            const hlsUrl = manualHlsBase
                ? `${manualHlsBase}/${roomCode}.m3u8`
                : `${protocol}://${baseHost}/hls/${roomCode}.m3u8`;

            broadcastToRoom(room.id, {
                type: 'stream:started',
                data: {
                    roomCode,
                    stream: room.stream,
                    participantCount: room.participants.length
                }
            });
            
            console.log(`Stream started in room: ${roomCode}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                streamUrl: publicWatchUrl,
                rtmpUrl: rtmpUrl,
                hlsUrl: hlsUrl,
                stream: {
                    ...room.stream,
                    viewerUrl: publicWatchUrl
                },
                room: {
                    code: room.code,
                    hostId: room.hostId,
                    participantCount: room.participants.length
                },
                video: {
                    width: 1920,
                    height: 1080,
                    bitrate: 3_500_000,
                    fps: 30,
                    keyFrameIntervalSec: 1,
                    audioBitrate: 128_000
                }
            }));
        } catch (error) {
            console.error('Error starting stream:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to start stream'
            }));
        }
    });
}

// Handle stream stop
function handleStreamStop(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        try {
            const data = JSON.parse(body || '{}');
            const { roomCode } = data;
            
            // Find room by code
            let room = null;
            for (const [roomId, r] of rooms.entries()) {
                if (r.code === roomCode) {
                    room = r;
                    break;
                }
            }
            
            if (!room) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Room not found'
                }));
                return;
            }
            
            // Update room stream status
            if (room.stream) {
                room.stream.status = 'stopped';
                room.stream.stoppedAt = new Date().toISOString();
            }
            broadcastToRoom(room.id, {
                type: 'stream:stopped',
                data: {
                    roomCode,
                    stream: room.stream,
                    participantCount: room.participants.length
                }
            });
            
            console.log(`Stream stopped in room: ${roomCode}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                room: room
            }));
        } catch (error) {
            console.error('Error stopping stream:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to stop stream'
            }));
        }
    });
}

// Handle get rooms
function handleGetRooms(req, res) {
    const activeRooms = Array.from(rooms.values()).map(room => ({
        id: room.id,
        code: room.code,
        status: room.status,
        participantCount: room.participants.length,
        hasStream: !!room.stream,
        createdAt: room.createdAt
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        success: true,
        rooms: activeRooms,
        total: activeRooms.length
    }));
}

// Generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Clean up expired rooms
function cleanupExpiredRooms() {
    const now = new Date();
    for (const [roomId, room] of rooms.entries()) {
        if (new Date(room.expiresAt) < now) {
            rooms.delete(roomId);
            console.log(`Expired room removed: ${room.code}`);
        }
    }
}

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    ws.clientId = clientId;
    console.log(`WebSocket connected: ${clientId}`);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        data: { 
            clientId: clientId,
            timestamp: new Date().toISOString()
        }
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`WebSocket message from ${clientId}: ${message.type}`);
            
            switch (message.type) {
                case 'create-room':
                    handleWebSocketCreateRoom(ws, message);
                    break;
                case 'join-room':
                    handleWebSocketJoinRoom(ws, message);
                    break;
                case 'signaling':
                    handleWebSocketSignaling(ws, message);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        data: { timestamp: new Date().toISOString() }
                    }));
                    break;
                default:
                    console.log(`Unknown message type: ${message.type}`);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`WebSocket disconnected: ${clientId}`);
        // Remove from any rooms
        for (const [roomId, room] of rooms.entries()) {
            room.participants = room.participants.filter(p => p.clientId !== clientId);
        }
        participants.delete(clientId);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
    });
});

// WebSocket room creation
function handleWebSocketCreateRoom(ws, message) {
    const roomCode = generateRoomCode();
    const roomId = uuidv4();
    
    const room = {
        id: roomId,
        code: roomCode,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        participants: [{ clientId: ws.clientId, joinedAt: new Date().toISOString() }],
        status: 'active'
    };
    
    rooms.set(roomId, room);
    participants.set(ws.clientId, { roomId, role: 'host' });
    
    ws.send(JSON.stringify({
        type: 'room-created',
        data: { room: room }
    }));
    
    console.log(`WebSocket room created: ${roomCode} by ${ws.clientId}`);
}

// WebSocket room joining
function handleWebSocketJoinRoom(ws, message) {
    const payload = (message && typeof message === 'object' && message.data && typeof message.data === 'object')
        ? message.data
        : null;

    if (!payload) {
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Invalid join-room payload' }
        }));
        console.warn(`join-room payload missing data object from ${ws.clientId}:`, message);
        return;
    }

    const { roomCode } = payload;

    if (!roomCode) {
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Room code is required' }
        }));
        console.warn(`join-room payload missing roomCode from ${ws.clientId}:`, message);
        return;
    }
    
    // Find room by code
    let room = null;
    for (const [roomId, r] of rooms.entries()) {
        if (r.code === roomCode) {
            room = r;
            break;
        }
    }
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Room not found' }
        }));
        return;
    }
    
    // Add participant
    const participant = {
        clientId: ws.clientId,
        joinedAt: new Date().toISOString()
    };
    
    room.participants.push(participant);
    participants.set(ws.clientId, { roomId: room.id, role: 'participant' });
    
    ws.send(JSON.stringify({
        type: 'room-joined',
        data: { room: room }
    }));
    
    // Notify other participants
    broadcastToRoom(room.id, {
        type: 'participant-joined',
        data: { participant: participant }
    }, ws.clientId);
    
    console.log(`WebSocket room joined: ${roomCode} by ${ws.clientId}`);
}

// WebSocket signaling
function handleWebSocketSignaling(ws, message) {
    const participant = participants.get(ws.clientId);
    if (!participant) return;
    
    const { targetClientId, signalData } = message.data;
    
    // Forward signal to target client
    broadcastToClient(targetClientId, {
        type: 'signaling',
        data: {
            fromClientId: ws.clientId,
            signalData: signalData
        }
    });
}

// Broadcast to room
function broadcastToRoom(roomId, message, excludeClientId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.participants.forEach(participant => {
        if (participant.clientId !== excludeClientId) {
            broadcastToClient(participant.clientId, message);
        }
    });
}

// Broadcast to specific client
function broadcastToClient(clientId, message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.clientId === clientId) {
            client.send(JSON.stringify(message));
        }
    });
}

// Start cleanup interval
setInterval(cleanupExpiredRooms, 60000); // Clean every minute

// Start server
server.listen(PORT, () => {
    console.log(`🚀 QuickCast Pro Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});