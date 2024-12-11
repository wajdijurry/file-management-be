const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getIO } = require('../socket');

class CompressionService {
    static currentProcess = null;

    static async compressWithTar(filePaths, zipFilePath) {
        const args = [
            '-czf',     // Create gzipped tar archive
            zipFilePath, // Output file
            '-C',       // Change to directory
            path.dirname(filePaths[0]), // Use first file's directory as base
            ...filePaths.map(p => path.relative(path.dirname(filePaths[0]), p)) // Use relative paths
        ];
        return this.spawnCompressionProcess('tar', args);
    }

    static async compressWithSevenZip(filePaths, zipFilePath, sevenZFormat, compressionLevel) {
        const args = [
            'a',            // Add to archive
            `-t${sevenZFormat}`,  // Archive format
            `-mx=${compressionLevel}`,  // Compression level
            '-mmt=on',      // Multi-threading on
            zipFilePath,    // Output file
            ...filePaths    // Input files
        ];
        return this.spawnCompressionProcess('7z', args);
    }

    static async spawnCompressionProcess(command, args) {
        return new Promise((resolve, reject) => {
            const process = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdoutData = '';
            let stderrData = '';

            process.stdout.on('data', (data) => {
                stdoutData += data;
                console.log(`${command} stdout:`, data.toString());
            });

            process.stderr.on('data', (data) => {
                stderrData += data;
                console.error(`${command} stderr:`, data.toString());
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout: stdoutData, stderr: stderrData });
                } else {
                    let errorMessage = 'Compression failed';
                    if (code === 255 && stderrData.includes('Break signaled')) {
                        errorMessage = 'Compression was cancelled';
                    } else if (stderrData.includes('No space left on device')) {
                        errorMessage = 'Not enough disk space to complete compression';
                    } else if (stderrData.includes('Permission denied')) {
                        errorMessage = 'Permission denied while trying to compress files';
                    } else {
                        errorMessage = `Compression failed: ${stderrData.split('\n')[0]}`;
                    }
                    reject(new Error(errorMessage));
                }
            });

            process.on('error', (err) => {
                let errorMessage = 'Failed to start compression';
                if (err.code === 'ENOENT') {
                    errorMessage = `Compression tool '${command}' not found. Please ensure it is installed.`;
                }
                reject(new Error(errorMessage));
            });

            // Store the process so it can be killed later
            this.currentProcess = process;
        });
    }

    static async validateCompressedFile(zipFilePath, totalSize) {
        const stats = fs.statSync(zipFilePath);
        console.log('Compressed file size:', stats.size, 'bytes');
        
        // For very small files (< 10KB), allow up to 10x size increase
        // For larger files, allow up to 2x size increase
        const sizeThreshold = 10 * 1024; // 10KB
        const maxRatio = totalSize < sizeThreshold ? 10 : 2;
        
        if (stats.size > totalSize * maxRatio) {
            console.warn(`Warning: Compressed file size (${stats.size}) is larger than expected (${totalSize})`);
        }
        return stats.size;
    }

    static async compressFiles(filePaths, archivePath, archiveType = '7z', compressionLevel = 5, progressCallback = null, cancelCallback = null) {
        let totalSize = 0;
        let progressInterval;

        try {
            // Calculate total size for progress tracking
            for (const filePath of filePaths) {
                const stats = fs.statSync(filePath);
                totalSize += stats.size;
            }

            if (totalSize === 0) {
                throw new Error('No files to compress');
            }

            // Set up progress tracking
            let currentProgress = 0;
            const clearProgressInterval = () => {
                if (progressInterval) {
                    clearInterval(progressInterval);
                }
            };

            // Set up progress tracking interval
            if (progressCallback) {
                progressInterval = setInterval(() => {
                    currentProgress = Math.min(currentProgress + 2, 95);
                    progressCallback(currentProgress);
                }, 1000);
            }

            // Get compression command and args
            const { command, args } = this.getCompressionCommand(
                archiveType,
                filePaths,
                archivePath,
                compressionLevel
            );

            console.log('Creating archive with command:', {
                target: archivePath,
                compressionLevel,
                fileCount: filePaths.length,
                format: archiveType
            });

            // Execute compression
            await this.spawnCompressionProcessWithCancellation(command, args, cancelCallback);

            // Validate compressed file
            const archiveSize = await this.validateCompressedFile(archivePath, totalSize);

            // Send 100% progress
            if (progressCallback) {
                progressCallback(100);
            }

            return {
                success: true,
                archivePath: archivePath,
                archiveSize: archiveSize
            };
        } catch (error) {
            console.error('Compression error:', error);
            if (fs.existsSync(archivePath)) {
                fs.unlinkSync(archivePath);
            }
            throw error;
        } finally {
            if (progressInterval) {
                clearInterval(progressInterval);
            }
        }
    }

    static async spawnCompressionProcessWithCancellation(command, args, cancelCallback) {
        return new Promise((resolve, reject) => {
            const process = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdoutData = '';
            let stderrData = '';

            process.stdout.on('data', (data) => {
                stdoutData += data;
                console.log(`${command} stdout:`, data.toString());
            });

            process.stderr.on('data', (data) => {
                stderrData += data;
                console.error(`${command} stderr:`, data.toString());
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout: stdoutData, stderr: stderrData });
                } else {
                    let errorMessage = 'Compression failed';
                    if (code === 255 && stderrData.includes('Break signaled')) {
                        errorMessage = 'Compression was cancelled';
                    } else if (stderrData.includes('No space left on device')) {
                        errorMessage = 'Not enough disk space to complete compression';
                    } else if (stderrData.includes('Permission denied')) {
                        errorMessage = 'Permission denied while trying to compress files';
                    } else {
                        errorMessage = `Compression failed: ${stderrData.split('\n')[0]}`;
                    }
                    reject(new Error(errorMessage));
                }
            });

            process.on('error', (err) => {
                let errorMessage = 'Failed to start compression';
                if (err.code === 'ENOENT') {
                    errorMessage = `Compression tool '${command}' not found. Please ensure it is installed.`;
                }
                reject(new Error(errorMessage));
            });

            // Store the process so it can be killed later
            this.currentProcess = process;

            // Check for cancellation
            if (cancelCallback) {
                cancelCallback(() => {
                    if (this.currentProcess) {
                        console.log('Killing compression process...');
                        try {
                            this.currentProcess.kill('SIGTERM');
                            this.currentProcess = null;
                            reject(new Error('Compression cancelled'));
                        } catch (error) {
                            console.error('Error killing compression process:', error);
                            reject(new Error('Compression failed'));
                        }
                    }
                });
            }
        });
    }

    static getCompressionCommand(archiveType, filePaths, zipFilePath, compressionLevel) {
        if (archiveType === 'tgz') {
            return {
                command: 'tar',
                args: [
                    '-czf',
                    zipFilePath,
                    '-C',
                    path.dirname(filePaths[0]),
                    ...filePaths.map(p => path.relative(path.dirname(filePaths[0]), p))
                ]
            };
        }

        return {
            command: '7z',
            args: [
                'a',
                `-t${archiveType}`,
                `-mx=${compressionLevel}`,
                '-mmt=on',
                zipFilePath,
                ...filePaths
            ]
        };
    }

    static killCurrentProcess() {
        if (this.currentProcess) {
            console.log('Killing compression process...');
            try {
                this.currentProcess.kill('SIGTERM');
                this.currentProcess = null;
                return true;
            } catch (error) {
                console.error('Error killing compression process:', error);
                return false;
            }
        }
        return false;
    }
}

module.exports = CompressionService;
