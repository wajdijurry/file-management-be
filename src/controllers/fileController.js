const FileService = require('../services/fileService');
const path = require('path');
const fs = require('fs');
const { getIO } = require('../socket');

exports.uploadFiles = async (req, res) => {
    try {
        const { filename, currentChunk, totalChunks, folderId } = req.body;
        const chunk = req.file; // Assuming you're using multer or similar middleware

        if (!filename || currentChunk == null || totalChunks == null || !chunk) {
            return res.status(400).json({ error: 'Missing required parameters or file chunk' });
        }

        const userId = req.userId; // Assuming userId is attached by middleware

        // Delegate chunk processing and progress tracking to FileService
        await FileService.processChunkAndTrackProgress(userId, filename, folderId, chunk, currentChunk, totalChunks);

        return res.status(200).json({ message: 'Chunk uploaded successfully', currentChunk });
    } catch (error) {
        console.error('Error uploading chunk:', error);
        return res.status(500).json({ error: 'Failed to upload chunk' });
    }
};

// Get all files
exports.getFiles = async (req, res) => {
    try {
        const folderName = req.query.folder || '';
        const parentFolderId = req.query.parent_id || null;

        const files = await FileService.getFiles(req.userId, parentFolderId);
        res.status(200).json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Download file
exports.downloadFile = async (req, res) => {
    try {
        const filePath = await FileService.getFile(req.userId, req.params.filename);
        res.download(filePath);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
};

// View file
exports.viewFile = async (req, res) => {
    try {
        const { filePath, mimeType } = await FileService.viewFile(req.userId, req.params.fileId);

        if (mimeType) {
            res.setHeader('Content-Type', mimeType);
        }

        if (['application/pdf'].includes(mimeType)) {
            res.setHeader('Content-Disposition', 'inline');
        }

        const fileStream = await FileService.getFileStream(filePath);

        if (!fileStream) {
            throw new Error('Failed to create file stream');
        }

        fileStream.on('error', (error) => {
            console.error('File streaming error:', error.message);
            res.status(500).send('File streaming error');
        });

        fileStream.on('end', () => {
            console.log('File stream ended');
        });

        fileStream.pipe(res).on('finish', () => {
            console.log('Response stream finished');
        });

    } catch (err) {
        res.status(404).json({ error: err.message });
    }
};

// Function to delete a single file
exports.deleteFile = async (req, res) => {
    try {
        await FileService.deleteFile(req.userId, req.params.id);
        res.json({ success: true, message: 'File deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete file.' });
    }
};

// Function to delete multiple files
exports.deleteMultipleFiles = async (req, res) => {
    const { ids, parentId } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No file IDs provided.' });
    }

    try {
        const deletedCount = await FileService.deleteMultipleFiles(req.userId, ids, parentId);

        if (deletedCount > 0) {
            return res.json({ success: true, message: 'Files deleted successfully.', deletedCount });
        } else {
            return res.status(404).json({ success: false, message: 'No files found for the provided IDs.' });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: 'An error occurred while deleting files.' });
    }
};

exports.createFolder = async (req, res) => {
    const { name, parentId } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Folder name is required' });
    }

    try {
        await FileService.createFolder(req.userId, name, parentId);
        res.status(201).json({ message: 'Folder created successfully' });
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
};

exports.compressFiles = async (req, res) => {
    try {
        const { items, folder, zipFileName, parentId } = req.body;

        const progressCallback = (progress) => {
            const io = getIO();
            io.emit('compressionProgress', { progress });
        };

        const compressedFile = await FileService.compressFiles(req.userId, items, folder, zipFileName, parentId, progressCallback);
        res.status(200).json({ message: 'Files compressed successfully', file: compressedFile });
    } catch (error) {
        console.error('Error compressing files:', error);
        res.status(500).json({ error: error.message });
    }
};

// exports.decompressFile = async (req, res) => {
//     try {
//         const { filePath, targetFolder, merge, parentId } = req.body;
//
//         if (!filePath || !targetFolder) {
//             return res.status(400).json({ error: 'filePath and targetFolder are required' });
//         }
//
//         console.log('Decompressing file:', filePath, 'into folder:', targetFolder); // Debugging line
//         const result = await FileService.decompressFile(req.userId, filePath, targetFolder, merge, parentId);
//         res.status(200).json(result);
//     } catch (error) {
//         console.error('Error decompressing file:', error);
//         res.status(500).json({ error: error.message });
//     }
// };

exports.decompressFile = async (req, res) => {
    try {
        const { filePath, targetFolder, parentId, merge } = req.body;

        if (!filePath || !targetFolder) {
            return res.status(400).json({ error: 'filePath and targetFolder are required.' });
        }

        console.log(`Decompressing ${filePath} into ${targetFolder} with merge=${merge}`);

        const conflictCallback = async (item, destPath) => {
            res.write(JSON.stringify({ conflict: { name: item, path: destPath } }) + '\n');
            return new Promise((resolve) => {
                req.once('continueDecompression', (decision) => resolve(decision));
            });
        };

        const result = await FileService.decompressFileWithConflictHandling(
            req.userId,
            filePath,
            targetFolder,
            parentId,
            merge,
            conflictCallback
        );

        res.end(JSON.stringify(result)); // Ensure response is terminated
    } catch (error) {
        console.error('Error decompressing file:', error.message);
        res.status(500).json({ error: 'Failed to decompress the file.' });
    }
};

exports.checkDecompressionConflicts = async (req, res) => {
    try {
        const { filePath, targetFolder } = req.body;

        if (!filePath || !targetFolder) {
            return res.status(400).json({ error: 'filePath and targetFolder are required.' });
        }

        const result = await FileService.checkDecompressionConflicts(req.userId, filePath, targetFolder);

        res.status(200).json(result);
    } catch (error) {
        console.error('Error checking decompression conflicts:', error.message);
        res.status(500).json({ error: 'Failed to check for decompression conflicts.' });
    }
};


exports.stopCompression = async (req, res) => {
    try {
        const { zipFileName, folder, parentId } = req.body;

        if (!zipFileName || !folder) {
            return res.status(400).json({ error: 'zipFileName and folder are required.' });
        }

        const stopped = await FileService.stopCompression(req.userId, zipFileName, folder, parentId);

        if (stopped) {
            res.status(200).json({ message: 'Compression process stopped successfully.' });
        } else {
            res.status(404).json({ error: 'No ongoing compression found for the specified file.' });
        }
    } catch (error) {
        console.error('Error stopping compression:', error);
        res.status(500).json({ error: 'Failed to stop compression.' });
    }
};

// Function to delete a single file
exports.renameItem = async (req, res) => {
    try {
        await FileService.renameItem(req.userId, req.body.itemId, req.body.newName, req.body.isFolder);
        res.json({ success: true, message: 'File/Folder renamed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to rename file/folder.' });
    }
};

// exports.moveItem = async (req, res) => {
//     const { itemId, targetFolderId } = req.body;
//
//     try {
//         const result = await FileService.moveItem(itemId, targetFolderId);
//         res.status(200).json(result);
//     } catch (error) {
//         console.error('Error moving item:', error.message);
//         res.status(500).json({ message: error.message });
//     }
// };

exports.moveItem = async (req, res) => {
    const { itemIds, targetId, isTargetZip } = req.body;

    try {
        if (isTargetZip) {
            const result = await FileService.moveItemsIntoZip(req.userId, itemIds, targetId);
            res.status(200).json({ success: true, message: 'Items moved into ZIP file successfully', result });
        } else {
            const result = await FileService.moveItem(itemIds, targetId);
            res.status(200).json({ success: true, message: 'Items moved successfully', result });
        }
    } catch (error) {
        console.error('Error moving items:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};


exports.download = async (req, res) => {
    const filePath = req.body.filePath;
    const absolutePath = path.join(FileService.uploadDirectory, filePath);

    try {
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).send('File not found.');
        }

        const stats = fs.statSync(absolutePath);
        const fileSize = stats.size;
        const range = req.headers.range;

        if (range) {
            // Parse the Range header
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize) {
                res.status(416).send('Requested range not satisfiable');
                return;
            }

            const chunkSize = end - start + 1;
            const fileStream = fs.createReadStream(absolutePath, { start, end });

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'application/octet-stream',
            });

            fileStream.pipe(res);
        } else {
            // Full file download
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'application/octet-stream',
            });

            fs.createReadStream(absolutePath).pipe(res);
        }
    } catch (error) {
        console.error('Error during download:', error.message);
        res.status(500).send('Failed to download file.');
    }
};

exports.getFileSize = async (req, res) => {
    const filePath = path.join(FileService.uploadDirectory, req.body.filePath);
    const absolutePath = path.resolve(filePath);

    try {
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).send('File not found.');
        }

        const stats = fs.statSync(absolutePath);
        res.json({ success: true, fileSize: stats.size });
    } catch (error) {
        console.error('Error fetching file size:', error.message);
        res.status(500).json({success: false, message: 'Failed to retrieve file size.'});
    }
};

exports.getUploadStatus = async (req, res) => {
    const { filename } = req.query;

    try {
        if (!filename) {
            return res.status(400).json({ message: 'Filename is required.' });
        }

        // Query the database or storage system for uploaded chunks
        const uploadStatus = await FileService.getUploadedChunks(filename, req.userId);

        if (!uploadStatus) {
            return res.status(404).json({ success: true, message: 'No upload progress found for the specified file.' });
        }

        res.status(200).json(uploadStatus); // Return the list of uploaded chunks
    } catch (error) {
        console.error('Error fetching upload status:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch upload status.' });
    }
};

