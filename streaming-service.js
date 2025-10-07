const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

class StreamingService {
    constructor(rooms = null) {
        this.activeStreams = new Map(); // roomCode -> ffmpeg process
        this.stdinProcesses = new Map(); // roomCode -> stdin stream
        this.streamDir = path.join(__dirname, 'streams');
        this.lastProgressLog = new Map(); // roomCode -> timestamp để throttle log
        this.rooms = rooms; // Reference to rooms Map from server.js
        
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
        // ✅ WRAP TOÀN BỘ LOGIC TRONG try-catch
        return new Promise(async (resolve, reject) => {
            try {
                // Kiểm tra nếu stream đã tồn tại
                if (this.activeStreams.has(roomCode)) {
                    console.log(`Stream ${roomCode} already exists`);
                    return resolve(this.getPlaylistUrl(roomCode));
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
                    '-preset', 'ultrafast',       // Thay vì veryfast để spawn nhanh hơn
                    '-tune', 'zerolatency',
                    '-profile:v', 'baseline',
                    '-level', '3.0',
                    '-pix_fmt', 'yuv420p',
                    '-g', '30',
                    '-keyint_min', '30',
                    '-sc_threshold', '0',
                    '-b:v', '2000k',
                    '-maxrate', '2500k',
                    '-bufsize', '3000k',
                    '-b:a', '128k',
                    '-ar', '44100',
                    '-f', 'hls',
                    '-hls_time', '1',
                    '-hls_list_size', '6',
                    '-hls_flags', 'delete_segments+independent_segments',
                    '-hls_segment_type', 'mpegts',
                    '-hls_segment_filename', segmentPattern,
                    '-loglevel', 'warning',       // Giảm log xuống warning để dễ debug
                    playlistPath
                ];

                console.log(`🎬 Spawning FFmpeg for room ${roomCode}...`);

                let ffmpeg;
                let spawnErrorOccurred = false;
                
                try {
                    ffmpeg = spawn('ffmpeg', ffmpegArgs);
                    
                    // ✅ THÊM: Check PID ngay sau spawn
                    if (!ffmpeg.pid) {
                        console.error(`❌ FFmpeg spawn failed - no PID assigned`);
                        return reject(new Error('FFmpeg spawn failed - no PID assigned'));
                    }
                    
                    console.log(`✅ FFmpeg spawned successfully, PID: ${ffmpeg.pid}`);
                } catch (spawnError) {
                    console.error(`❌ FFmpeg spawn failed:`, spawnError);
                    return reject(new Error(`FFmpeg spawn failed: ${spawnError.message}`));
                }
                
                // ✅ THÊM: Global error handler cho FFmpeg process
                ffmpeg.on('error', (error) => {
                    if (!spawnErrorOccurred) {
                        spawnErrorOccurred = true;
                        console.error(`💥 FFmpeg process error for ${roomCode}:`, error.message);
                        this.activeStreams.delete(roomCode);
                        this.stdinProcesses.delete(roomCode);
                        reject(new Error(`FFmpeg process error: ${error.message}`));
                    }
                });
                
                // ✅ THÊM: Timeout để detect FFmpeg không khởi động được
                const spawnTimeout = setTimeout(() => {
                    if (!spawnErrorOccurred) {
                        spawnErrorOccurred = true;
                        console.error(`❌ FFmpeg spawn timeout - process may not have started`);
                        if (ffmpeg && !ffmpeg.killed) {
                            ffmpeg.kill('SIGKILL');
                        }
                        reject(new Error('FFmpeg spawn timeout - process may not have started'));
                    }
                }, 5000); // 5 giây timeout cho spawn
                
                // ✅ FIX: Đợi FFmpeg stdin ready với timeout dài hơn
                console.log(`🔧 Waiting for FFmpeg stdin ready for room ${roomCode}...`);
                try {
                    await new Promise((resolveStdin, rejectStdin) => {
                        const stdinTimeout = setTimeout(() => {
                            if (!spawnErrorOccurred) {
                                rejectStdin(new Error('FFmpeg stdin ready timeout after 10 seconds'));
                            }
                        }, 10000); // ✅ TĂNG lên 10 giây cho Railway

                        // Check if stdin is immediately writable
                        if (ffmpeg.stdin && ffmpeg.stdin.writable) {
                            console.log(`✅ FFmpeg stdin immediately ready for room ${roomCode}`);
                            clearTimeout(stdinTimeout);
                            clearTimeout(spawnTimeout); // ✅ Clear spawn timeout
                            resolveStdin();
                        } else {
                            // Wait for stdin to become writable
                            let checkCount = 0;
                            const checkStdin = () => {
                                checkCount++;
                                if (ffmpeg.stdin && ffmpeg.stdin.writable) {
                                    console.log(`✅ FFmpeg stdin ready after ${checkCount} checks for room ${roomCode}`);
                                    clearTimeout(stdinTimeout);
                                    clearTimeout(spawnTimeout); // ✅ Clear spawn timeout
                                    resolveStdin();
                                } else if (checkCount < 200) { // Max 200 checks (10 seconds / 50ms)
                                    setTimeout(checkStdin, 50);
                                } else {
                                    clearTimeout(stdinTimeout);
                                    rejectStdin(new Error('FFmpeg stdin never became writable'));
                                }
                            };
                            checkStdin();
                        }
                    });
                } catch (stdinError) {
                    console.error(`❌ stdin ready failed:`, stdinError);
                    clearTimeout(spawnTimeout); // ✅ Clear spawn timeout
                    if (ffmpeg && !ffmpeg.killed) {
                        ffmpeg.kill('SIGKILL');
                    }
                    return reject(stdinError);
                }

                // ✅ Lưu stdin stream SAU KHI đã ready
                this.stdinProcesses.set(roomCode, ffmpeg.stdin);
                console.log(`✅ stdin process registered for room ${roomCode}`);

                // Setup FFmpeg output handlers
                ffmpeg.stdout.on('data', (data) => {
                    const output = data.toString();
                    if (output.trim()) {
                        console.log(`FFmpeg ${roomCode} stdout:`, output.trim());
                    }
                });

                ffmpeg.stderr.on('data', (data) => {
                    const output = data.toString();
                    // Chỉ log những thông tin quan trọng
                    if (output.includes('error') || output.includes('Error') || 
                        output.includes('failed') || output.includes('Failed')) {
                        console.error(`❌ FFmpeg ${roomCode} error:`, output.trim());
                    } else if (output.includes('frame=') || output.includes('time=')) {
                        // Log progress mỗi 10 giây
                        const now = Date.now();
                        const lastLog = this.lastProgressLog.get(roomCode) || 0;
                        if (now - lastLog > 10000) {
                            console.log(`📊 FFmpeg ${roomCode} progress:`, output.trim().split('\n')[0]);
                            this.lastProgressLog.set(roomCode, now);
                        }
                    } else if (output.trim()) {
                        console.log(`🔧 FFmpeg ${roomCode}:`, output.trim());
                    }
                });

                ffmpeg.on('close', (code) => {
                    console.log(`🏁 FFmpeg ${roomCode} exited with code ${code}`);
                    this.activeStreams.delete(roomCode);
                    this.stdinProcesses.delete(roomCode);
                    this.lastProgressLog.delete(roomCode);

                    if (code !== 0 && code !== null) {
                        console.error(`❌ FFmpeg ${roomCode} exited with error code ${code}`);
                    }

                    setTimeout(() => {
                        this.cleanupRoom(roomCode);
                    }, 30000);
                });

                // Lưu process
                this.activeStreams.set(roomCode, ffmpeg);
                console.log(`✅ FFmpeg process registered for room ${roomCode}`);

                // ✅ GIẢM thời gian chờ initialization xuống
                console.log(`⏳ Waiting 500ms for FFmpeg initialization...`);
                await new Promise(resolveInit => setTimeout(resolveInit, 500));

                // ✅ Đợi playlist được tạo với timeout dài hơn
                console.log(`🔍 Waiting for playlist creation at: ${playlistPath}`);
                try {
                    await new Promise((resolvePlaylist, rejectPlaylist) => {
                        let checkCount = 0;
                        const checkInterval = setInterval(() => {
                            checkCount++;

                            if (checkCount % 10 === 0) {
                                console.log(`📋 Check #${checkCount}, exists: ${fs.existsSync(playlistPath)}`);
                            }

                            if (fs.existsSync(playlistPath)) {
                                clearInterval(checkInterval);

                                // Get dynamic server address
                                const serverAddress = process.env.DOMAIN || 
                                                    `http://localhost:${process.env.PORT || 8080}`;
                                const hlsUrl = `${serverAddress}/streams/${roomCode}/playlist.m3u8`;
                                const watchUrl = `${serverAddress}/watch/${roomCode}`;

                                console.log(`📺 HLS playlist ready for room ${roomCode}: ${hlsUrl}`);

                                // Notify via HTTP
                                this.notifyStreamReady(serverAddress, roomCode, hlsUrl, watchUrl);

                                // ✅ Notify Web Client qua WebSocket
                                this.notifyWebClientStreamReady(roomCode, hlsUrl, watchUrl);

                                resolvePlaylist();
                            }
                        }, 200); // Check mỗi 200ms

                        // ✅ TĂNG timeout lên 15 giây cho Railway
                        setTimeout(() => {
                            clearInterval(checkInterval);
                            console.error(`❌ Playlist timeout after ${checkCount} checks for room ${roomCode}`);
                            rejectPlaylist(new Error('Playlist creation timeout after 15 seconds'));
                        }, 15000);
                    });
                } catch (playlistError) {
                    console.error(`❌ Playlist creation failed:`, playlistError);
                    // Cleanup FFmpeg
                    if (ffmpeg && !ffmpeg.killed) {
                        ffmpeg.kill('SIGTERM');
                    }
                    this.activeStreams.delete(roomCode);
                    this.stdinProcesses.delete(roomCode);
                    return reject(playlistError);
                }

                // ✅ SUCCESS - resolve với playlist URL
                const playlistUrl = this.getPlaylistUrl(roomCode);
                console.log(`✅ Stream started successfully for room ${roomCode}: ${playlistUrl}`);
                resolve(playlistUrl);

            } catch (error) {
                console.error(`❌ Error in startStreamFromStdin for ${roomCode}:`, error);
                reject(error);
            }
        });
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
        
        // ✅ THÊM: Notify Web Client about viewer count
        this.notifyViewerCountUpdate(roomCode, currentCount + 1);
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
        
        // ✅ THÊM: Notify Web Client about viewer count
        this.notifyViewerCountUpdate(roomCode, newCount);
        
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
     * Notify Web Client về viewer count update
     * @param {string} roomCode - Mã phòng
     * @param {number} viewerCount - Số lượng viewers
     */
    notifyViewerCountUpdate(roomCode, viewerCount) {
        try {
            if (!this.rooms) {
                console.warn('⚠️ Rooms reference not available');
                return;
            }
            
            const room = this.rooms.get(roomCode);
            
            if (room && room.web && room.web.readyState === 1) { // WebSocket.OPEN
                const viewerUpdateMessage = {
                    type: 'viewer_count_update',
                    roomCode: roomCode,
                    viewerCount: viewerCount,
                    timestamp: new Date().toISOString()
                };
                
                room.web.send(JSON.stringify(viewerUpdateMessage));
                console.log(`📤 Sent viewer count update to Web Client: ${viewerCount} viewers for room ${roomCode}`);
            }
        } catch (error) {
            console.error('❌ Error notifying viewer count update:', error.message);
        }
    }

    /**
     * Notify Web Client qua WebSocket khi stream ready
     * @param {string} roomCode - Mã phòng
     * @param {string} hlsUrl - URL HLS playlist
     * @param {string} watchUrl - URL trang xem
     */
    notifyWebClientStreamReady(roomCode, hlsUrl, watchUrl) {
        try {
            if (!this.rooms) {
                console.warn('⚠️ Rooms reference not available');
                return;
            }
            
            const room = this.rooms.get(roomCode);
            
            if (room && room.web && room.web.readyState === 1) { // WebSocket.OPEN
                const streamReadyMessage = {
                    type: 'stream_ready',
                    roomCode: roomCode,
                    hlsUrl: hlsUrl,
                    watchPageUrl: watchUrl,
                    timestamp: new Date().toISOString()
                };
                
                room.web.send(JSON.stringify(streamReadyMessage));
                console.log(`📤 Sent stream_ready to Web Client for room ${roomCode}`);
                
                // ✅ THÊM: Notify Android client too if available
                if (room.android && room.android.readyState === 1) {
                    room.android.send(JSON.stringify(streamReadyMessage));
                    console.log(`📤 Sent stream_ready to Android Client for room ${roomCode}`);
                }
            } else {
                console.warn(`⚠️ Web Client not available for room ${roomCode}`);
            }
        } catch (error) {
            console.error('❌ Error notifying Web Client:', error.message);
        }
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