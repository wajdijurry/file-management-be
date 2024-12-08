// socket.js
let io;

module.exports = {
    init: (server, corsOptions) => {
        if (io) {
            throw new Error('Socket.IO is already initialized!');
        }
        io = require('socket.io')(server, {
            cors: corsOptions,
        });

        // Authentication middleware
        io.use((socket, next) => {
            const token = socket.handshake.auth.token;
            if (!token) {
                return next(new Error('Authentication error: Token missing'));
            }

            try {
                const jwt = require('jsonwebtoken');
                const payload = jwt.verify(token, process.env.JWT_SECRET);
                socket.userId = payload.userId;
                next();
            } catch (err) {
                return next(new Error('Authentication error: Invalid token'));
            }
        });

        // Socket event handlers
        io.on('connection', (socket) => {
            console.log('A user connected:', socket.id);

            socket.on('joinRoom', (userId) => {
                socket.join(userId);
                console.log(`User ${socket.id} joined room ${userId}`);
            });

            socket.on('cancelOperation', async (data) => {
                const { jobId } = data;
                const compressionQueue = require('./queues/compressionQueue');
                
                try {
                    // Use the new cancelJob function that handles both active and queued jobs
                    const cancelled = await compressionQueue.cancelJob(jobId, jobId);

                    if (cancelled) {
                        socket.emit('operationCancelled', {
                            jobId,
                            message: 'Operation cancelled successfully'
                        });
                    } else {
                        socket.emit('operationCancelError', {
                            jobId,
                            error: 'Operation not found or already completed'
                        });
                    }
                } catch (error) {
                    console.error('Error cancelling operation:', error);
                    socket.emit('operationCancelError', {
                        jobId,
                        error: 'Failed to cancel operation: ' + error.message
                    });
                }
            });
        });

        return io;
    },

    getIO: () => {
        if (!io) {
            throw new Error('Socket.IO is not initialized!');
        }
        return io;
    }
};
