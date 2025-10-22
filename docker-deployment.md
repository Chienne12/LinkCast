# Docker Deployment Guide

## Quick Start with Docker

### 1. Build and Run
```bash
# Build the image
docker build -t quickcast-pro-server .

# Run the container
docker run -d \
  --name quickcast-pro \
  -p 3001:3001 \
  -e NODE_ENV=production \
  quickcast-pro-server
```

### 2. Using Docker Compose
```bash
# Start the service
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the service
docker-compose down
```

## Production Deployment

### Environment Variables
- `NODE_ENV`: Set to `production`
- `PORT`: Server port (default: 3001)
- `WS_PORT`: WebSocket port (default: 3001)

### Health Checks
The container includes a built-in health check:
- Endpoint: `/health`
- Interval: 30s
- Timeout: 3s
- Retries: 3

### Security Features
- Non-root user (nodejs:1001)
- Minimal Alpine Linux base
- Production-only dependencies
- Read-only filesystem support

## Docker Hub Deployment

### 1. Build and Push
```bash
# Build with tag
docker build -t your-username/quickcast-pro-server:latest .

# Push to Docker Hub
docker push your-username/quickcast-pro-server:latest
```

### 2. Pull and Run
```bash
# Pull the image
docker pull your-username/quickcast-pro-server:latest

# Run in production
docker run -d \
  --name quickcast-pro \
  -p 3001:3001 \
  -e NODE_ENV=production \
  your-username/quickcast-pro-server:latest
```

## Cloud Platform Deployment

### AWS ECS
```json
{
  "family": "quickcast-pro",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::account:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "quickcast-pro-server",
      "image": "your-username/quickcast-pro-server:latest",
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3
      }
    }
  ]
}
```

### Google Cloud Run
```bash
# Build and push to Google Container Registry
gcloud builds submit --tag gcr.io/PROJECT-ID/quickcast-pro-server

# Deploy to Cloud Run
gcloud run deploy quickcast-pro \
  --image gcr.io/PROJECT-ID/quickcast-pro-server \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 3001 \
  --set-env-vars NODE_ENV=production
```

### Azure Container Instances
```bash
# Create container instance
az container create \
  --resource-group quickcast-pro-rg \
  --name quickcast-pro-server \
  --image your-username/quickcast-pro-server:latest \
  --ports 3001 \
  --environment-variables NODE_ENV=production \
  --cpu 1 \
  --memory 1
```

## Monitoring and Logs

### View Logs
```bash
# Docker logs
docker logs quickcast-pro

# Docker Compose logs
docker-compose logs -f quickcast-pro-server
```

### Monitor Health
```bash
# Check container health
docker inspect quickcast-pro | grep Health -A 10

# Test health endpoint
curl http://localhost:3001/health
```

## Troubleshooting

### Common Issues
1. **Port conflicts**: Ensure port 3001 is available
2. **Memory limits**: Monitor container memory usage
3. **WebSocket connections**: Check proxy configuration for WebSocket upgrades

### Debug Mode
```bash
# Run with debug logging
docker run -d \
  --name quickcast-pro-debug \
  -p 3001:3001 \
  -e NODE_ENV=development \
  -e DEBUG=* \
  quickcast-pro-server
```

## Performance Optimization

### Resource Limits
```yaml
# docker-compose.yml with resource limits
services:
  quickcast-pro-server:
    build: .
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
```

### Scaling with Docker Swarm
```bash
# Initialize swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.yml quickcast-pro

# Scale service
docker service scale quickcast-pro_quickcast-pro-server=3
```