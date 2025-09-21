# LinkCast Pro Signaling Server

WebRTC Signaling Server cho ứng dụng LinkCast Pro - truyền màn hình Android lên web.

## 🚀 Tính năng

- **WebSocket Server** cho WebRTC signaling
- **Room-based** communication
- **Auto cleanup** dead connections
- **Cross-platform** support

## 📦 Cài đặt

```bash
npm install
```

## 🏃‍♂️ Chạy server

```bash
# Development
npm run dev

# Production
npm start
```

## 🌐 Deploy

### Vercel (Recommended)
```bash
npm i -g vercel
vercel
```

### Heroku
```bash
git push heroku main
```

### Railway
```bash
railway login
railway init
railway up
```

## 📡 API

### WebSocket Endpoints
- `ws://localhost:8080` - Local development
- `wss://your-domain.com` - Production

### Message Types
- `join` - Join room
- `offer` - WebRTC offer
- `answer` - WebRTC answer
- `ice` - ICE candidate

## 🔧 Environment Variables

- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment (development/production)

## 📝 License

MIT License
