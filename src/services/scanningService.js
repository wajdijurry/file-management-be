const { fileEvents, EVENT_TYPES } = require('./eventService');
const scanningQueue = require('../queues/scanningQueue');
const config = require('../config');

class ScanningService {
    static isEnabled = false;
    static isInitialized = false;

    static initialize() {
        // Only initialize once
        if (this.isInitialized) return;
        
        console.log('Initializing ScanningService...');
        console.log('Virus scanning enabled:', config.virusScanning?.enabled);

        // Only set up listeners if scanning is enabled
        if (config.virusScanning?.enabled) {
            this.isEnabled = true;
            this.setupListeners();
            console.log('Virus scanning listeners set up successfully');
        }

        this.isInitialized = true;
    }

    static setupListeners() {
        console.log('Setting up file upload listeners for virus scanning...');
        
        fileEvents.on(EVENT_TYPES.FILE_UPLOADED, async (data) => {
            if (!this.isEnabled) return;

            const { fileId, userId } = data;
            console.log(`Queueing file ${fileId} for virus scanning...`);
            
            try {
                // Queue the file for scanning
                await scanningQueue.add({
                    fileId,
                    userId
                }, {
                    attempts: 3,
                    backoff: {
                        type: 'exponential',
                        delay: 2000
                    }
                });
                console.log(`File ${fileId} queued for scanning successfully`);
            } catch (error) {
                console.error(`Error queueing file ${fileId} for scanning:`, error);
            }
        });
    }

    static enable() {
        if (!this.isInitialized) {
            this.initialize();
        }
        this.isEnabled = true;
        console.log('Virus scanning enabled');
    }

    static disable() {
        this.isEnabled = false;
        console.log('Virus scanning disabled');
    }
}

module.exports = ScanningService;
