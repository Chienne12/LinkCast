# Sử dụng Node.js 18 với Ubuntu base image để có thể cài FFmpeg
FROM node:18

# Cài đặt FFmpeg và các dependencies cần thiết
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Tạo thư mục làm việc
WORKDIR /app

# Copy package files
COPY package*.json ./

# Cài đặt dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Tạo thư mục streams
RUN mkdir -p streams

# Expose port (Railway sẽ tự động gán PORT)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8082}/health || exit 1

# Start the application
CMD ["node", "server.js"]
