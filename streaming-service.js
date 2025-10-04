const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

class StreamingService {
    constructor() {
        this.activeStreams = new Map(); // roomCode -> ffmpeg process
        this.stdinProcesses = new Map(); // roomCode -> stdin stream
        this.streamDir = path.join(__dirname, 'streams');
        this.lastProgressLog = new Map(); // roomCode -> timestamp để throttle log
        
        // Viewer tracking system
        this.viewerCounts = new Map(); // roomCode -> viewer count
        this.lastViewerActivity = new Map(); // roomCode -> timestamp of last viewer activity
        this.autoStopTimers = new Map(); // roomCode -> timeout ID for auto-stop
        
        // Tạo thư mục streams nếu chưa có
        if (!fs.existsSync(this.streamDir)) {
            fs.mkdirSync(this.streamDir, { recursive: true });
        }
        
        // Start viewer activity monitoring
        this.startViewerMonitoring();
    }

    /**
     * Bắt đầu streaming từ stdin (WebSocket binary data)
     * @param {string} roomCode - Mã phòng 6 ký tự
     * @returns {Promise<string>} - URL HLS playlist
     */
    async startStreamFromStdin(roomCode) {
        try {
            // Kiểm tra nếu stream đã tồn tại
            if (this.activeStreams.has(roomCode)) {
                console.log(`Stream ${roomCode} already exists`);
                return this.getPlaylistUrl(roomCode);
            }

            // Tạo thư mục cho room
            const roomDir = path.join(this.streamDir, roomCode);
            if (!fs.existsSync(roomDir)) {
                fs.mkdirSync(roomDir, { recursive: true });
            }

            const playlistPath = path.join(roomDir, 'playlist.m3u8');
            const segmentPattern = path.join(roomDir, 'segment_%03d.ts');

            // FFmpeg command để convert WebM từ stdin sang HLS
            const ffmpegArgs = [
                '-i', 'pipe:0',               // Read from stdin
                '-f', 'webm',                 // Input format từ MediaRecorder
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'veryfast',        // Cân bằng giữa tốc độ và chất lượng
                '-tune', 'zerolatency',       // Tối ưu cho streaming real-time
                '-profile:v', 'baseline',     // Tương thích tốt với mobile
                '-level', '3.0',              // Tương thích rộng
                '-pix_fmt', 'yuv420p',        // Pixel format tương thích
                '-g', '30',                   // GOP size = 30 frames
                '-keyint_min', '30',          // Minimum keyframe interval
                '-sc_threshold', '0',         // Disable scene change detection
                '-b:v', '2000k',              // Tăng từ 1000k lên 2000k để giảm keyframe interval
                '-maxrate', '2500k',          // Tăng từ 1200k lên 2500k
                '-bufsize', '3000k',          // Tăng buffer size tương ứng
                '-b:a', '128k',               // Audio bitrate 128kbps
                '-ar', '44100',               // Audio sample rate
                '-f', 'hls',
                '-hls_time', '1',             // Giảm từ 2s xuống 1s để giảm latency
                '-hls_list_size', '6',        // Giữ 6 segments (6 giây buffer thay vì 12s)
                '-hls_flags', 'delete_segments+independent_segments',
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename', segmentPattern,
                '-loglevel', 'info',          // Log level để debug
                playlistPath
            ];

            console.log(`Starting FFmpeg from stdin for room ${roomCode}:`, ffmpegArgs.join(' '));

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            
            // Lưu stdin stream để write chunks
            this.stdinProcesses.set(roomCode, ffmpeg.stdin);
            
            ffmpeg.stdout.on('data', (data) => {
                console.log(`FFmpeg ${roomCode} stdout:`, data.toString());
            });

            ffmpeg.stderr.on('data', (data) => {
                const output = data.toString();
                // Chỉ log những thông tin quan trọng, không spam console
                if (output.includes('error') || output.includes('Error') || 
                    output.includes('failed') || output.includes('Failed')) {
                    console.error(`❌ FFmpeg ${roomCode} error:`, output.trim());
                } else if (output.includes('frame=') || output.includes('time=')) {
                    // Log progress mỗi 10 giây thay vì random
                    const now = Date.now();
                    const lastLog = this.lastProgressLog.get(roomCode) || 0;
                    if (now - lastLog > 10000) { // 10 giây
                        console.log(`📊 FFmpeg ${roomCode} progress:`, output.trim().split('\n')[0]);
                        this.lastProgressLog.set(roomCode, now);
                    }
                } else {
                    console.log(`🔧 FFmpeg ${roomCode}:`, output.trim());
                }
            });

            ffmpeg.on('close', (code) => {
                console.log(`🏁 FFmpeg ${roomCode} exited with code ${code}`);
                this.activeStreams.delete(roomCode);
                this.stdinProcesses.delete(roomCode);
                this.lastProgressLog.delete(roomCode);
                
                // Chỉ cleanup nếu exit code không phải 0 (lỗi) hoặc SIGTERM (dừng bình thường)
                if (code !== 0 && code !== null) {
                    console.error(`❌ FFmpeg ${roomCode} exited with error code ${code}`);
                }
                
                // Delay cleanup để client có thể tải segment cuối
                setTimeout(() => {
                    this.cleanupRoom(roomCode);
                }, 30000); // 30 giây
            });

            ffmpeg.on('error', (error) => {
                console.error(`💥 FFmpeg ${roomCode} process error:`, error.message);
                this.activeStreams.delete(roomCode);
                this.stdinProcesses.delete(roomCode);
                this.lastProgressLog.delete(roomCode);
                
                // Cleanup ngay lập tức khi có lỗi process
                setTimeout(() => {
                    this.cleanupRoom(roomCode);
                }, 2000);
            });

            // Lưu process
            this.activeStreams.set(roomCode, ffmpeg);

            // Đợi FFmpeg khởi tạo với timeout ngắn hơn vì stdin stream
            console.log(`🔧 Waiting for FFmpeg initialization for room ${roomCode}...`);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.log(`✅ FFmpeg stdin stream started for room ${roomCode}`);
                    resolve();
                }, 1000); // Giảm xuống 1 giây

                // Cleanup timeout
                const originalResolve = resolve;
                resolve = () => {
                    clearTimeout(timeout);
                    originalResolve();
                };
            });

            // Đợi playlist được tạo và notify clients
            console.log(`🔍 Waiting for playlist creation at: ${playlistPath}`);
            await new Promise((resolve, reject) => {
                let checkCount = 0;
                const checkInterval = setInterval(() => {
                    checkCount++;
                    console.log(`📋 Check ${checkCount}: Looking for playlist at ${playlistPath}`);
                    
                    if (fs.existsSync(playlistPath)) {
                        clearInterval(checkInterval);
                        
                        // Notify clients qua HTTP endpoint
                        const serverAddress = process.env.DOMAIN || `http://localhost:${process.env.PORT || 8082}`;
                        const hlsUrl = `${serverAddress}/streams/${roomCode}/playlist.m3u8`;
                        const watchUrl = `${serverAddress}/watch/${roomCode}`;
                        
                        console.log(`📺 HLS playlist ready for room ${roomCode}: ${hlsUrl}`);
                        
                        // Gửi notification đến server endpoint bằng http.request()
                        this.notifyStreamReady(serverAddress, roomCode, hlsUrl, watchUrl);
                        
                        resolve();
                    }
                }, 200); // Giảm interval xuống 200ms để check nhanh hơn
                
                setTimeout(() => {
                    clearInterval(checkInterval);
                    console.error(`❌ Playlist timeout after ${checkCount} checks for room ${roomCode}`);
                    reject(new Error('Playlist timeout'));
                }, 10000); // Giảm timeout xuống 10 giây
            });

            return this.getPlaylistUrl(roomCode);

        } catch (error) {
            console.error(`Error starting stdin stream for ${roomCode}:`, error);
            throw error;
        }
    }

    /**
     * Ghi chunk data vào stdin của FFmpeg với backpressure handling
     * @param {string} roomCode - Mã phòng
     * @param {Buffer} chunk - Binary data chunk
     * @returns {boolean} - true nếu có thể tiếp tục ghi, false nếu cần đợi
     */
    writeChunk(roomCode, chunk) {
        const stdin = this.stdinProcesses.get(roomCode);
        if (stdin && !stdin.destroyed) {
            try {
                const canWrite = stdin.write(chunk);
                if (!canWrite) {
                    // Buffer đầy - cần backpressure handling
                    console.warn(`⚠️ stdin buffer full for room ${roomCode}, waiting for drain...`);
                    
                    // Emit event để client có thể pause MediaRecorder
                    stdin.once('drain', () => {
                        console.log(`✅ stdin drained for room ${roomCode}, can resume`);
                        // Có thể emit event để client resume MediaRecorder
                    });
                    
                    return false; // Báo hiệu cần đợi
                }
                return true; // Có thể tiếp tục ghi
            } catch (error) {
                console.error(`Error writing chunk to ${roomCode}:`, error);
                return false;
            }
        } else {
            console.warn(`No stdin process found for room ${roomCode}`);
            return false;
        }
    }

    /**
     * Bắt đầu streaming cho room
     * @param {string} roomCode - Mã phòng 6 ký tự
     * @param {string} inputUrl - URL WebRTC stream (từ web client)
     * @returns {Promise<string>} - URL HLS playlist
     */
    async startStream(roomCode, inputUrl) {
        try {
            // Kiểm tra nếu stream đã tồn tại
            if (this.activeStreams.has(roomCode)) {
                console.log(`Stream ${roomCode} already exists`);
                return this.getPlaylistUrl(roomCode);
            }

            // Tạo thư mục cho room
            const roomDir = path.join(this.streamDir, roomCode);
            if (!fs.existsSync(roomDir)) {
                fs.mkdirSync(roomDir, { recursive: true });
            }

            const playlistPath = path.join(roomDir, 'playlist.m3u8');
            const segmentPattern = path.join(roomDir, 'segment_%03d.ts');

            // FFmpeg command để convert WebRTC sang HLS với tối ưu cho low latency
            const ffmpegArgs = [
                '-i', inputUrl,
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'veryfast',        // Cân bằng giữa tốc độ và chất lượng
                '-tune', 'zerolatency',       // Tối ưu cho streaming real-time
                '-profile:v', 'baseline',     // Tương thích tốt với mobile
                '-level', '3.0',              // Tương thích rộng
                '-pix_fmt', 'yuv420p',        // Pixel format tương thích
                '-g', '30',                   // GOP size = 30 frames
                '-keyint_min', '30',          // Minimum keyframe interval
                '-sc_threshold', '0',         // Disable scene change detection
                '-b:v', '2000k',              // Tăng từ 1000k lên 2000k để giảm keyframe interval
                '-maxrate', '2500k',          // Tăng từ 1200k lên 2500k
                '-bufsize', '3000k',          // Tăng buffer size tương ứng
                '-b:a', '128k',               // Audio bitrate 128kbps
                '-ar', '44100',               // Audio sample rate
                '-f', 'hls',
                '-hls_time', '1',             // Giảm từ 2s xuống 1s để giảm latency
                '-hls_list_size', '6',        // Giữ 6 segments (6 giây buffer thay vì 12s)
                '-hls_flags', 'delete_segments+independent_segments',
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename', segmentPattern,
                '-loglevel', 'info',          // Log level để debug
                playlistPath
            ];

            console.log(`Starting FFmpeg for room ${roomCode}:`, ffmpegArgs.join(' '));

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            
            ffmpeg.stdout.on('data', (data) => {
                console.log(`FFmpeg ${roomCode} stdout:`, data.toString());
            });

            ffmpeg.stderr.on('data', (data) => {
                const output = data.toString();
                // Chỉ log những thông tin quan trọng, không spam console
                if (output.includes('error') || output.includes('Error') || 
                    output.includes('failed') || output.includes('Failed')) {
                    console.error(`❌ FFmpeg ${roomCode} error:`, output.trim());
                } else if (output.includes('frame=') || output.includes('time=')) {
                    // Log progress mỗi 10 giây thay vì random
                    const now = Date.now();
                    const lastLog = this.lastProgressLog.get(roomCode) || 0;
                    if (now - lastLog > 10000) { // 10 giây
                        console.log(`📊 FFmpeg ${roomCode} progress:`, output.trim().split('\n')[0]);
                        this.lastProgressLog.set(roomCode, now);
                    }
                } else {
                    console.log(`🔧 FFmpeg ${roomCode}:`, output.trim());
                }
            });

            ffmpeg.on('close', (code) => {
                console.log(`🏁 FFmpeg ${roomCode} exited with code ${code}`);
                this.activeStreams.delete(roomCode);
                this.lastProgressLog.delete(roomCode); // Cleanup progress log tracking
                
                // Chỉ cleanup nếu exit code không phải 0 (lỗi) hoặc SIGTERM (dừng bình thường)
                if (code !== 0 && code !== null) {
                    console.error(`❌ FFmpeg ${roomCode} exited with error code ${code}`);
                }
                
                // Delay cleanup để client có thể tải segment cuối
                setTimeout(() => {
                    this.cleanupRoom(roomCode);
                }, 30000); // 30 giây - tăng từ 10s để tránh viewer bị 404
            });

            ffmpeg.on('error', (error) => {
                console.error(`💥 FFmpeg ${roomCode} process error:`, error.message);
                this.activeStreams.delete(roomCode);
                this.lastProgressLog.delete(roomCode); // Cleanup progress log tracking
                
                // Cleanup ngay lập tức khi có lỗi process
                setTimeout(() => {
                    this.cleanupRoom(roomCode);
                }, 2000);
            });

            // Lưu process
            this.activeStreams.set(roomCode, ffmpeg);

            // Đợi FFmpeg khởi tạo và tạo playlist với timeout
            await new Promise((resolve, reject) => {
                const checkInterval = setInterval(() => {
                    if (fs.existsSync(playlistPath)) {
                        clearInterval(checkInterval);
                        console.log(`✅ Playlist created for room ${roomCode}`);
                        resolve();
                    }
                }, 500);

                // Timeout sau 15 giây
                const timeout = setTimeout(() => {
                    clearInterval(checkInterval);
                    console.error(`❌ FFmpeg did not create playlist.m3u8 for room ${roomCode} in time`);
                    
                    // Cleanup failed stream
                    if (this.activeStreams.has(roomCode)) {
                        const failedFFmpeg = this.activeStreams.get(roomCode);
                        failedFFmpeg.kill('SIGTERM');
                        this.activeStreams.delete(roomCode);
                        this.lastProgressLog.delete(roomCode);
                    }
                    
                    reject(new Error(`FFmpeg startup failed for room ${roomCode}: playlist not created in time`));
                }, 15000);

                // Cleanup timeout if resolved early
                const originalResolve = resolve;
                resolve = () => {
                    clearTimeout(timeout);
                    originalResolve();
                };
            });

            return this.getPlaylistUrl(roomCode);

        } catch (error) {
            console.error(`Error starting stream for ${roomCode}:`, error);
            throw error;
        }
    }

    /**
     * Dừng streaming cho room
     * @param {string} roomCode - Mã phòng
     */
    stopStream(roomCode) {
        // Đóng stdin stream trước khi kill process
        const stdin = this.stdinProcesses.get(roomCode);
        if (stdin && !stdin.destroyed) {
            console.log(`Closing stdin stream for room ${roomCode}`);
            stdin.end();
            this.stdinProcesses.delete(roomCode);
        }

        const ffmpeg = this.activeStreams.get(roomCode);
        if (ffmpeg) {
            console.log(`Stopping stream for room ${roomCode}`);
            ffmpeg.kill('SIGTERM');
            this.activeStreams.delete(roomCode);
            this.lastProgressLog.delete(roomCode);
            
            // Cleanup sau 30 giây - tăng từ 5s để tránh viewer bị 404
            setTimeout(() => {
                this.cleanupRoom(roomCode);
            }, 30000);
        }
    }

    /**
     * Lấy URL playlist HLS
     * @param {string} roomCode - Mã phòng
     * @returns {string} - URL playlist
     */
    getPlaylistUrl(roomCode) {
        return `/streams/${roomCode}/playlist.m3u8`;
    }

    /**
     * Lấy URL trang viewer
     * @param {string} roomCode - Mã phòng
     * @returns {string} - URL trang viewer
     */
    getViewerUrl(roomCode) {
        return `/watch/${roomCode}`;
    }

    /**
     * Kiểm tra stream có đang hoạt động không
     * @param {string} roomCode - Mã phòng
     * @returns {boolean}
     */
    isStreamActive(roomCode) {
        return this.activeStreams.has(roomCode);
    }

    /**
     * Dọn dẹp thư mục room
     * @param {string} roomCode - Mã phòng
     */
    cleanupRoom(roomCode) {
        const roomDir = path.join(this.streamDir, roomCode);
        if (fs.existsSync(roomDir)) {
            try {
                fs.rmSync(roomDir, { recursive: true, force: true });
                console.log(`Cleaned up room directory: ${roomCode}`);
            } catch (error) {
                console.error(`Error cleaning up room ${roomCode}:`, error);
            }
        }
    }

    /**
     * Lấy danh sách streams đang hoạt động
     * @returns {Array<string>} - Danh sách room codes
     */
    getActiveStreams() {
        return Array.from(this.activeStreams.keys());
    }

    /**
     * Thêm viewer cho room
     * @param {string} roomCode - Mã phòng
     */
    addViewer(roomCode) {
        const currentCount = this.viewerCounts.get(roomCode) || 0;
        this.viewerCounts.set(roomCode, currentCount + 1);
        this.lastViewerActivity.set(roomCode, Date.now());
        
        // Clear auto-stop timer if exists
        if (this.autoStopTimers.has(roomCode)) {
            clearTimeout(this.autoStopTimers.get(roomCode));
            this.autoStopTimers.delete(roomCode);
        }
        
        console.log(`👥 Viewer joined room ${roomCode}. Total viewers: ${currentCount + 1}`);
    }

    /**
     * Xóa viewer khỏi room
     * @param {string} roomCode - Mã phòng
     */
    removeViewer(roomCode) {
        const currentCount = this.viewerCounts.get(roomCode) || 0;
        const newCount = Math.max(0, currentCount - 1);
        this.viewerCounts.set(roomCode, newCount);
        this.lastViewerActivity.set(roomCode, Date.now());
        
        console.log(`👥 Viewer left room ${roomCode}. Total viewers: ${newCount}`);
        
        // Start auto-stop timer if no viewers
        if (newCount === 0 && this.activeStreams.has(roomCode)) {
            this.scheduleAutoStop(roomCode);
        }
    }

    /**
     * Cập nhật hoạt động viewer (khi request HLS segments)
     * @param {string} roomCode - Mã phòng
     */
    updateViewerActivity(roomCode) {
        this.lastViewerActivity.set(roomCode, Date.now());
        
        // Ensure viewer count is at least 1 if there's activity
        if (!this.viewerCounts.has(roomCode) || this.viewerCounts.get(roomCode) === 0) {
            this.addViewer(roomCode);
        }
    }

    /**
     * Lên lịch auto-stop stream khi không có viewers
     * @param {string} roomCode - Mã phòng
     */
    scheduleAutoStop(roomCode) {
        // Clear existing timer
        if (this.autoStopTimers.has(roomCode)) {
            clearTimeout(this.autoStopTimers.get(roomCode));
        }
        
        // Set 30-second timer
        const timer = setTimeout(() => {
            const viewerCount = this.viewerCounts.get(roomCode) || 0;
            if (viewerCount === 0 && this.activeStreams.has(roomCode)) {
                console.log(`⏰ Auto-stopping stream ${roomCode} - no viewers for 30 seconds`);
                this.stopStream(roomCode);
            }
        }, 30000); // 30 seconds
        
        this.autoStopTimers.set(roomCode, timer);
        console.log(`⏰ Auto-stop scheduled for room ${roomCode} in 30 seconds`);
    }

    /**
     * Bắt đầu monitoring viewer activity
     */
    startViewerMonitoring() {
        // Check every 60 seconds for inactive viewers
        setInterval(() => {
            const now = Date.now();
            const inactiveThreshold = 60000; // 60 seconds
            
            for (const [roomCode, lastActivity] of this.lastViewerActivity.entries()) {
                if (now - lastActivity > inactiveThreshold) {
                    const viewerCount = this.viewerCounts.get(roomCode) || 0;
                    if (viewerCount > 0) {
                        console.log(`👥 Detected inactive viewers in room ${roomCode}, resetting count`);
                        this.viewerCounts.set(roomCode, 0);
                        if (this.activeStreams.has(roomCode)) {
                            this.scheduleAutoStop(roomCode);
                        }
                    }
                }
            }
        }, 60000); // Check every minute
    }

    /**
     * Lấy số lượng viewers hiện tại
     * @param {string} roomCode - Mã phòng
     * @returns {number} - Số lượng viewers
     */
    getViewerCount(roomCode) {
        return this.viewerCounts.get(roomCode) || 0;
    }

    /**
     * Gửi thông báo stream ready đến server endpoint
     * @param {string} serverAddress - Địa chỉ server
     * @param {string} roomCode - Mã phòng
     * @param {string} hlsUrl - URL HLS playlist
     * @param {string} watchUrl - URL trang xem
     */
    notifyStreamReady(serverAddress, roomCode, hlsUrl, watchUrl) {
        try {
            const notifyUrl = new URL(`${serverAddress}/api/notify-stream-ready`);
            const protocol = notifyUrl.protocol === 'https:' ? https : http;
            
            const postData = JSON.stringify({ 
                roomCode, 
                hlsUrl, 
                watchPageUrl: watchUrl 
            });
            
            const req = protocol.request({
                hostname: notifyUrl.hostname,
                port: notifyUrl.port,
                path: notifyUrl.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                console.log(`✅ Notify stream ready response: ${res.statusCode}`);
            });
            
            req.on('error', (err) => {
                console.error('❌ Failed to notify stream ready:', err.message);
            });
            
            req.write(postData);
            req.end();
            
        } catch (error) {
            console.error('❌ Error creating notify request:', error.message);
        }
    }
}

module.exports = StreamingService;