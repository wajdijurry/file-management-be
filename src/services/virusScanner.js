const NodeClam = require('clamscan');
const path = require('path');
const fs = require('fs').promises;

const ClamScan = new NodeClam().init({
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
});

class VirusScanner {
    static async scanFile(filePath) {
        try {
            const {isInfected, virusName} = await ClamScan.isInfected(filePath);
            if (isInfected) {
                await fs.unlink(filePath); // Delete infected file
                throw new Error(`Virus detected: ${virusName}`);
            }
            return {
                isClean: true,
                message: 'File is clean'
            };
        } catch (error) {
            if (error.message.includes('Virus detected')) {
                throw error;
            }
            throw new Error(`Error scanning file: ${error.message}`);
        }
    }

    static async scanBuffer(buffer, filename) {
        try {
            const tempPath = path.join('/tmp', `scan_${filename}_${Date.now()}`);
            await fs.writeFile(tempPath, buffer);
            
            try {
                const result = await this.scanFile(tempPath);
                await fs.unlink(tempPath); // Clean up temp file
                return result;
            } catch (error) {
                await fs.unlink(tempPath).catch(() => {}); // Clean up temp file even if scan fails
                throw error;
            }
        } catch (error) {
            throw new Error(`Error scanning buffer: ${error.message}`);
        }
    }
}

module.exports = VirusScanner;
