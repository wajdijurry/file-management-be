const Queue = require('bull');
const FileService = require('../services/fileService');
const socket = require('../socket');

// Redis connection configuration
const redisConfig = {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    }
};

// Create compression queue
const compressionQueue = new Queue('compression', redisConfig);

// Handle queue errors
compressionQueue.on('error', (error) => {
    console.error('Compression Queue Error:', error);
});

compressionQueue.on('failed', (job, error) => {
    console.error(`Job ${job.id} failed:`, error);
    try {
        const io = socket.getIO();
        io.to(job.data.userId).emit('compressionError', {
            jobId: job.id,
            error: error.message
        });
    } catch (err) {
        console.error('Failed to emit compression error:', err);
    }
});

// Process compression jobs
compressionQueue.process(async (job) => {
    const { userId, items, folder, zipFileName, parentId, archiveType, compressionLevel, progressId } = job.data;

    try {
        // Create progress callback that emits to socket
        const progressCallback = (progress) => {
            try {
                const io = socket.getIO();
                io.to(userId).emit('compressionProgress', {
                    jobId: job.id,
                    fileName: zipFileName,
                    progress,
                    progressId
                });
                job.progress(progress);
            } catch (err) {
                console.error('Failed to emit compression progress:', err);
            }
        };

        // Execute compression
        const result = await FileService.compressFiles(
            userId,
            items,
            folder,
            zipFileName,
            parentId,
            progressCallback,
            archiveType,
            compressionLevel
        );

        // Emit completion event
        try {
            const io = socket.getIO();
            io.to(userId).emit('compressionComplete', {
                jobId: job.id,
                fileName: zipFileName,
                success: true,
                file: result.file,
                progressId
            });
        } catch (err) {
            console.error('Failed to emit compression complete:', err);
        }

        return result;
    } catch (error) {
        console.error('Error in compression:', error);
        try {
            const io = socket.getIO();
            io.to(userId).emit('compressionError', {
                jobId: job.id,
                fileName: zipFileName,
                error: error.message,
                progressId
            });
        } catch (err) {
            console.error('Failed to emit compression error:', err);
        }
        throw error;
    }
});

module.exports = compressionQueue;
