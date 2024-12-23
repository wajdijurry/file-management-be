const NodeClam = require('clamscan');
const { getIO } = require('../socket');
const path = require('path');
const fs = require('fs');
const config = require('../config');

class VirusScanner {
    constructor() {
        const options = {
            removeInfected: false,
            quarantineInfected: false,
            scanLog: null,
            debugMode: false,
            fileList: null,
            scanRecursively: true,
            clamscan: {
                path: '/usr/bin/clamscan',
                db: null,
                scanArchives: true,
                active: true
            },
            preference: 'clamscan'
        };

        // Initialize ClamAV
        this.initializeScanner(options);
    }

    async initializeScanner(options) {
        try {
            this.clamscan = await new NodeClam().init(options);
            console.log('Virus scanner initialized successfully');
        } catch (error) {
            console.error('Failed to initialize virus scanner:', error);
            throw error;
        }
    }

    async scanFile(filePath) {
        try {
            // Ensure scanner is initialized
            if (!this.clamscan) {
                throw new Error('Virus scanner not initialized');
            }

            const io = getIO();
            const fileId = path.basename(filePath, path.extname(filePath));
            const fileName = path.basename(filePath);

            // Get file size for progress calculation
            await new Promise((resolve, reject) => {
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        io.emit('fileScanUpdate', { 
                            fileId,
                            fileName,
                            status: 'error',
                            error: 'Error while scanning file'
                        });
                        reject(err);
                    } else {
                        resolve(stats);
                    }
                });
            });

            // Perform the scan
            const {isInfected, viruses} = await this.clamscan.scanFile(filePath);

            return { isInfected, viruses };
        } catch (error) {
            console.error('Error in virus scanner:', error);
            throw error;
        }
    }

    async scanBuffer(buffer, filename) {
        try {
            const tempPath = path.join('/tmp', `scan_${filename}_${Date.now()}`);
            await fs.promises.writeFile(tempPath, buffer);
            
            try {
                return await this.scanFile(tempPath);
            } finally {
                // Clean up temp file
                await fs.promises.unlink(tempPath).catch(console.error);
            }
        } catch (error) {
            console.error('Error scanning buffer:', error);
            throw error;
        }
    }
}

// Create and export a singleton instance
const instance = new VirusScanner();
module.exports = instance;
