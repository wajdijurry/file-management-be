const FileService = require('../services/fileService');
const path = require('path');
const fs = require('fs');
const { getIO } = require('../socket');
const UploadProgress = require("../models/uplodPrgress");

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
        const parentFolderId = req.query.parent_id || null;
        const files = await FileService.getFiles(req.userId, parentFolderId);
        res.json(files);
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
        if (err.message === 'Password verification required') {
            res.status(401).json({ error: err.message });
        } else {
            res.status(404).json({ error: err.message });
        }
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

        return res.json({ success: true, message: 'Files deleted successfully.', deletedCount });
        // if (deletedCount > 0) {
        //     return res.json({ success: true, message: 'Files deleted successfully.', deletedCount });
        // } else {
        //     return res.status(404).json({ success: false, message: 'No files found for the provided IDs.' });
        // }
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
        res.status(500).json({ error: `Failed to create folder: ${error.message}` });
    }
};

exports.compressFiles = async (req, res) => {
    try {
        const userId = req.userId; 
        const { items, folder, parentId, zipFileName, archiveType, compressionLevel, progressId } = req.body;

        // Validate request
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid items array' });
        }

        // Add job to compression queue
        const compressionQueue = require('../queues/compressionQueue');
        const job = await compressionQueue.add({
            userId,
            items,
            folder,
            zipFileName,
            parentId,
            archiveType,
            compressionLevel,
            progressId
        });

        // Return job ID immediately
        res.json({ 
            success: true, 
            message: 'Compression started',
            jobId: job.id
        });
    } catch (error) {
        console.error('Error in compression:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.decompressFile = async (req, res) => {
    try {
        const { filePath, targetFolder, merge, parentId } = req.body;

        if (!filePath || !targetFolder) {
            return res.status(400).json({ error: 'filePath and targetFolder are required' });
        }

        console.log('Decompressing file:', filePath, 'into folder:', targetFolder); // Debugging line
        const result = await FileService.decompressFile(req.userId, filePath, targetFolder, parentId);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error decompressing file:', error);
        res.status(500).json({ error: error.message });
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
            res.status(200).json({ success: true,message: 'Compression process stopped successfully.' });
        } else {
            res.status(404).json({ success: false, error: 'No ongoing compression found for the specified file.' });
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
        res.status(500).json({ success: false, message: `Failed to rename file/folder: ${err.message}` });
    }
};

exports.moveItem = async (req, res) => {
    const { itemIds, targetId, isTargetZip, progressId } = req.body;

    try {
        const progressCallback = (itemName, progress) => {
            const io = getIO();
            io.emit('movingProgress', { itemName, progress, progressId });
        };

        if (isTargetZip) {
            const result = await FileService.moveItemsIntoZip(req.userId, itemIds, targetId);
            res.status(200).json({ success: true, message: 'Items moved into ZIP file successfully', result });
        } else {
            const result = await FileService.moveItems(req.userId, itemIds, targetId, progressCallback);
            res.status(200).json({ success: true, message: 'Items moved successfully', result });
        }
    } catch (error) {
        console.error('Error moving items:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};


exports.download = async (req, res) => {
    const filePath = req.body.filePath;
    const offset = parseInt(req.query.offset, 10) || 0;
    const chunkSize = parseInt(req.query.chunkSize, 10) || 1024 * 1024; // Default 1MB
    const absolutePath = path.join(FileService.uploadDirectory, filePath);

    console.log('Download request:', {
        filePath,
        offset,
        chunkSize,
        absolutePath
    });

    try {
        if (!fs.existsSync(absolutePath)) {
            console.error('File not found:', absolutePath);
            return res.status(404).send('File not found.');
        }

        const stats = fs.statSync(absolutePath);
        const fileSize = stats.size;

        // If offset equals file size, return a completed response
        if (offset >= fileSize) {
            console.log('Download complete - offset matches or exceeds file size:', {
                offset,
                fileSize
            });
            return res.status(204).end(); // No Content - indicates successful completion
        }

        // Calculate end position for the chunk
        const end = Math.min(offset + chunkSize - 1, fileSize - 1);
        const contentLength = end - offset + 1;
        
        console.log('Chunk details:', {
            fileSize,
            start: offset,
            end,
            contentLength,
            isLastChunk: end === fileSize - 1
        });

        const chunkStream = fs.createReadStream(absolutePath, { start: offset, end });

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': contentLength,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${offset}-${end}/${fileSize}`
        });

        chunkStream.pipe(res);
    } catch (error) {
        console.error('Error during download:', error);
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

exports.getFolderTree = async (req, res) => {
    try {
        const tree = await FileService.getFolderTree(req.userId, req.query.parentId); // Start from root
        res.status(200).json({ success: true, folders: tree });
    } catch (error) {
        console.error('Error fetching folder tree:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch folder tree' });
    }
};

// Set password protection
exports.setPassword = async (req, res) => {
    try {
        const { itemId, password, isFolder } = req.body;
        const result = await FileService.setPassword(req.userId, itemId, password, isFolder);
        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Remove password protection
exports.removePassword = async (req, res) => {
    try {
        const { itemId, currentPassword, isFolder } = req.body;
        const result = await FileService.removePassword(req.userId, itemId, currentPassword, isFolder);
        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Verify password for protected item
exports.verifyPassword = async (req, res) => {
    try {
        const { itemId, password, isFolder } = req.body;
        const result = await FileService.verifyPassword(req.userId, itemId, password, isFolder);
        if (result) {
            res.status(204).send();
        } else {
            res.status(401).json({ message: 'Invalid password' });
        }
    } catch (error) {
        console.error('Error verifying password:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
