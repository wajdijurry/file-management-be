const FileService = require('../services/fileService');

// Upload file
exports.uploadFiles = async (req, res) => {
    try {
        const folder = req.body.folder || ''; // Retrieve folder path from request body (defaults to root)
        const files = req.files; // Access uploaded files

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const results = await FileService.uploadFiles(req.userId, files, folder); // Pass files and target folder to the service
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

        const files = await FileService.getFiles(req.userId, folderName);
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

        if (mimeType === 'application/pdf') {
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
        res.status(500).json({ success: false, message: 'An error occurred while deleting files.' });
    }
};

exports.createFolder = async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Folder name is required' });
    }

    try {
        await FileService.createFolder(req.userId, name);
        res.status(201).json({ message: 'Folder created successfully' });
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
};

exports.compressFiles = async (req, res) => {
    try {
        const { items, folder, zipFileName } = req.body;
        const compressedFile = await FileService.compressFiles(req.userId, items, folder, zipFileName);
        res.status(200).json({ message: 'Files compressed successfully', file: compressedFile });
    } catch (error) {
        console.error('Error compressing files:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.decompressFile = async (req, res) => {
    try {
        const { filePath, targetFolder } = req.body;

        if (!filePath || !targetFolder) {
            return res.status(400).json({ error: 'filePath and targetFolder are required' });
        }

        console.log('Decompressing file:', filePath, 'into folder:', targetFolder); // Debugging line
        const result = await FileService.decompressFile(req.userId, filePath, targetFolder);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error decompressing file:', error);
        res.status(500).json({ error: error.message });
    }
};
