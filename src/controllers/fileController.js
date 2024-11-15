const FileService = require('../services/fileService');
const path = require('path');
const fs = require('fs');

// Upload file
exports.uploadFiles = async (req, res) => {
    try {
        const folder_id = req.body.folder_id || ''; // Retrieve folder path from request body (defaults to root)
        const files = req.files; // Access uploaded files

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const results = await FileService.uploadFiles(req.userId, files, folder_id); // Pass files and target folder to the service
        res.status(200).json({ message: 'Files uploaded successfully', results });
    } catch (error) {
        console.error('Error uploading files:', error);
        res.status(500).json({ error: 'File upload failed' });
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
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No file IDs provided.' });
    }

    try {
        const deletedCount = await FileService.deleteMultipleFiles(req.userId, ids);

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
        const compressedFile = await FileService.compressFiles(req.userId, items, folder, zipFileName, parentId);
        res.status(200).json({ message: 'Files compressed successfully', file: compressedFile });
    } catch (error) {
        console.error('Error compressing files:', error);
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
        const result = await FileService.decompressFile(req.userId, filePath, targetFolder, merge, parentId);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error decompressing file:', error);
        res.status(500).json({ error: error.message });
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

exports.moveItem = async (req, res) => {
    const { itemId, targetFolderId } = req.body;

    try {
        const result = await FileService.moveItem(itemId, targetFolderId);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error moving item:', error.message);
        res.status(500).json({ message: error.message });
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
        res.json({ fileSize: stats.size });
    } catch (error) {
        console.error('Error fetching file size:', error.message);
        res.status(500).send('Failed to retrieve file size.');
    }
};
