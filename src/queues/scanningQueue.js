const Queue = require('bull');
const File = require('../models/fileModel');
const VirusScanner = require('../services/virusScanner');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const FileService = require('../services/fileService');
const socket = require('../socket');

// Create scanning queue only if virus scanning is enabled
let scanningQueue = null;

if (config.virusScanning?.enabled) {
    scanningQueue = new Queue('virus-scanning', {
        redis: config.virusScanning.redis
    });

    // Process scanning jobs
    scanningQueue.process(async (job) => {
        const { fileId, userId } = job.data;
        console.log(`Starting virus scan for file ${fileId}`);
        const io = socket.getIO();

        try {
            // Get file document
            const file = await File.findById(fileId);
            if (!file) {
                throw new Error('File not found');
            }

            // Update status to scanning
            file.scanStatus = 'scanning';
            file.scanProgress = 0;
            await file.save();
            
            // Emit initial progress
            io.to(userId).emit('fileScanUpdate', {
                fileId: file._id,
                fileName: file.name,
                status: 'scanning',
                progress: 0
            });

            console.log(`Updated status to scanning for file ${fileId}`);

            // Scan the file
            const filePath = path.join(FileService.uploadDirectory, file.path);
            console.log(`Scanning file at path: ${filePath}`);
            
            const result = await VirusScanner.scanFile(filePath);
            console.log(`Scan completed for file ${fileId}. Result:`, result);

            // Update file based on scan results
            file.scanStatus = result.isInfected ? 'infected' : 'clean';
            file.scanResult = result.viruses?.join(', ') || null;
            file.scanDate = new Date();
            file.scanProgress = 100;
            
            if (result.isInfected) {
                console.log(`Virus detected in file ${fileId}. Deleting file...`);
                // Delete infected file
                fs.unlinkSync(filePath);
                file.deleted = true;
            }

            await file.save();

            // Emit final status
            io.to(userId).emit('fileScanUpdate', {
                fileId: file._id,
                fileName: file.name,
                status: file.scanStatus,
                progress: 100,
                result: file.scanResult
            });

            console.log(`Updated final scan status for file ${fileId}: ${file.scanStatus}`);

            return { success: true, fileId, scanStatus: file.scanStatus };
        } catch (error) {
            console.error(`Error scanning file ${fileId}:`, error);
            
            // Update file status on error
            if (fileId) {
                const file = await File.findById(fileId);
                if (file) {
                    file.scanStatus = 'infected'; // Treat errors as potential threats
                    file.scanResult = error.message;
                    file.scanDate = new Date();
                    file.scanProgress = 0;
                    await file.save();

                    // Emit error status
                    io.to(userId).emit('fileScanUpdate', {
                        fileId: file._id,
                        fileName: file.name,
                        status: 'error',
                        error: error.message
                    });

                    console.log(`Updated error status for file ${fileId}`);
                }
            }
            
            throw error;
        }
    });

    // Handle completed jobs
    scanningQueue.on('completed', (job, result) => {
        console.log(`Scanning completed for file ${result.fileId}: ${result.scanStatus}`);
    });

    // Handle failed jobs
    scanningQueue.on('failed', (job, error) => {
        console.error(`Scanning failed for file ${job.data.fileId}:`, error);
    });
}

module.exports = scanningQueue;
