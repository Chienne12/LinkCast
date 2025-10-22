# Railway Deployment Configuration

## Overview
This configuration enables automatic deployment of QuickCast Pro server to Railway.

## Environment Variables
Set these in Railway dashboard:

```
NODE_ENV=production
PORT=3001
WS_PORT=3001
```

## Deployment Steps

1. **Connect Repository**
   - Link your GitHub repository to Railway
   - Select the `/server` folder as root directory

2. **Configure Environment**
   - Add environment variables above
   - Railway will automatically detect Node.js

3. **Deploy**
   - Railway will run `npm install` automatically
   - Start command: `npm start`
   - Server will be available at: `your-app-name.railway.app`

## Railway-Specific Files

### railway.json (Optional)
```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health"
  }
}
```

### .nixpacks.toml (Optional)
```toml
[phases.setup]
nixPkgs = ["nodejs", "npm"]

[phases.build]
cmds = ["npm install"]

[start]
cmd = "npm start"
```

## Features Enabled
- ✅ Automatic Node.js detection
- ✅ WebSocket support
- ✅ Health checks
- ✅ Zero-downtime deployments
- ✅ Custom domain support
- ✅ Environment variables
- ✅ Log streaming

## Post-Deployment
1. Update frontend config with Railway URL:
   ```javascript
   CONFIG.SERVER.WS_URL = 'wss://your-app-name.railway.app';
   ```

2. Test WebSocket connection
3. Verify room creation functionality
4. Check streaming capabilities

## Cost Optimization
- Free tier: $0/month (up to 500 hours)
- Hobby tier: $5/month (unlimited hours)
- No credit card required for free tier

## Monitoring
- Railway provides built-in metrics
- Check logs in Railway dashboard
- Monitor WebSocket connections
- Track API response times