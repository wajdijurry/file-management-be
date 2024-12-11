const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const UploadProgress = require('../models/uplodPrgress');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime');
const archiver = require('archiver');
const extract = require('extract-zip');
const { AbortController } = require('abort-controller');
const AdmZip = require('adm-zip');
const bcrypt = require('bcrypt');
const Seven = require('node-7z');
const { spawn } = require('child_process');
const CompressionService = require('./compressionService');

class FileService {
    static uploadDirectory = path.join(__dirname, '../../public/uploads');
    static ongoingCompressions = new Map();

    static async uploadFile(userId, fileName, folderId = null, chunk, currentChunk, totalChunks)
    {
        let uploadDir = FileService.uploadDirectory;
        let relativeUploadDir = '';

        if (folderId) {
            let folder = await Folder.findById(folderId);
            if (folder) {
                uploadDir = path.join(uploadDir, folder.path);
                relativeUploadDir = folder.path;
            }
        } else {
            uploadDir = path.join(uploadDir, userId);
        }

        // Ensure chunk directory exists
        fs.mkdirSync(uploadDir, { recursive: true });

        // Save the chunk
        let chunkDir = path.join(uploadDir, `chunks`);

        if(!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
        }

        const chunkPath = path.join(chunkDir, `chunk_${currentChunk}`);
        fs.writeFileSync(chunkPath, chunk.buffer);

        // If all chunks are uploaded, combine them
        if (parseInt(currentChunk) >= parseInt(totalChunks)) {
            await FileService.combineChunks(chunkDir, uploadDir, relativeUploadDir, fileName, userId, folderId);
        }
    }

    static async combineChunks(chunkDir, uploadDir, relativeUploadDir, filename, userId, parentId) {
        try {
            const targetPath = path.join(uploadDir, filename);
            const chunks = fs.readdirSync(chunkDir).sort((a, b) => {
                const aNum = parseInt(a.split('_')[1]);
                const bNum = parseInt(b.split('_')[1]);
                return aNum - bNum;
            });

            // Create write stream for the target file
            const writeStream = fs.createWriteStream(targetPath);

            for (const chunk of chunks) {
                const chunkPath = path.join(chunkDir, chunk);
                const chunkData = fs.readFileSync(chunkPath);
                writeStream.write(chunkData);
                fs.unlinkSync(chunkPath); // Remove chunk after appending
            }

            writeStream.end();

            await this.saveFileMetadata(targetPath, userId, filename, parentId, relativeUploadDir, writeStream);

            this.recalculateFolderStats(parentId);

            // Remove the chunks directory
            fs.rmdirSync(chunkDir);

            console.log(`File ${filename} successfully combined and saved.`);
        } catch (error) {
            console.error('Error combining chunks:', error);
            throw new Error('Failed to combine file chunks');
        }
    }

    static calculateFolderSize(folderPath) {
        let totalSize = 0;

        const items = fs.readdirSync(folderPath);
        items.forEach((item) => {
            const itemPath = path.join(folderPath, item);
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                totalSize += this.calculateFolderSize(itemPath);
            } else {
                totalSize += stats.size;
            }
        });

        return totalSize;
    }

    static calculateTotalSize(items, userId) {
        let totalSize = 0;

        items.forEach(async (item) => {
            try {
                let itemPath;
                if (item.type === 'folder') {
                    const folder = await Folder.findById(item.id);
                    if (!folder || folder.userId.toString() !== userId) {
                        throw new Error(`Folder not found or access denied: ${item.name}`);
                    }
                    itemPath = path.join(this.uploadDirectory, folder.path);
                } else {
                    const file = await File.findById(item.id);
                    if (!file || file.userId.toString() !== userId) {
                        throw new Error(`File not found or access denied: ${item.name}`);
                    }
                    itemPath = path.join(this.uploadDirectory, file.path);
                }

                const stats = fs.statSync(itemPath);
                if (stats.isDirectory()) {
                    totalSize += this.calculateFolderSize(itemPath);
                } else {
                    totalSize += stats.size;
                }
            } catch (error) {
                console.error(`Error calculating size for ${item.name}:`, error);
                throw error;
            }
        });

        return totalSize;
    }

    static async *streamFilesGenerator(userId, parentId = null) {
        try {
            // Stream folders using a Mongoose cursor
            const foldersStream = Folder.find({ userId, parent_id: parentId, deleted: false }).cursor();

            for await (const folder of foldersStream) {
                const childCount = await Folder.countDocuments({ parent_id: folder._id.toString(), deleted: false }) +
                    await File.countDocuments({ parent_id: folder._id.toString(), deleted: false });

                const isLocked = folder.isPasswordProtected &&
                    !folder.userAccess.some(access => access.userId === userId.toString());

                yield {
                    id: folder._id.toString(),
                    name: folder.name,
                    isFolder: true,
                    hasChildren: childCount > 0,
                    isLocked,
                    isPasswordProtected: folder.isPasswordProtected,
                    size: folder.size,  // Use the stored size from database
                    createdAt: folder.createdAt,
                    path: folder.path
                };
            }

            // Stream files using another Mongoose cursor
            const filesStream = File.find({ userId, parent_id: parentId, deleted: false }).cursor();

            for await (const file of filesStream) {
                const isLocked = file.isPasswordProtected &&
                    !file.userAccess.some(access => access.userId === userId.toString());

                yield {
                    id: file._id.toString(),
                    name: file.name,
                    isFolder: false,
                    size: file.size,
                    createdAt: file.createdAt,
                    mimetype: file.mimetype,
                    type: file.mimetype ? file.mimetype.split('/')[0] : 'unknown',
                    path: file.path,
                    isLocked,
                    isPasswordProtected: file.isPasswordProtected
                };
            }
        } catch (error) {
            console.error('Error streaming files:', error);
            throw new Error('Failed to stream files and folders');
        }
    }

    static async updateFolderSize(folderId) {
        const folder = await Folder.findById(folderId);
        if (!folder) return;

        const folderPath = path.join(this.uploadDirectory, folder.path);
        if (fs.existsSync(folderPath)) {
            const size = this.calculateFolderSize(folderPath);
            await Folder.updateOne({ _id: folderId }, { size });

            // Update parent folder sizes recursively
            if (folder.parent_id) {
                await this.updateFolderSize(folder.parent_id);
            }
        }
    }

    static async recalculateFolderStats(folderId) {
        if (!folderId || folderId === 'root') {
            return;
        }

        try {
            // Find the folder
            const folder = await Folder.findById(folderId);
            if (!folder) return;

            // Get all immediate children (files and folders)
            const [files, subfolders] = await Promise.all([
                File.find({ parent_id: folderId, deleted: false }),
                Folder.find({ parent_id: folderId, deleted: false })
            ]);

            // Calculate stats
            let totalSize = 0;
            const fileCount = files.length;
            const folderCount = subfolders.length;

            // Sum up file sizes
            totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);

            // Add subfolder sizes
            for (const subfolder of subfolders) {
                totalSize += subfolder.size || 0;
            }

            // Update folder stats
            folder.size = totalSize;
            folder.fileCount = fileCount;
            folder.folderCount = folderCount;
            await folder.save();

            // Update parent folder if exists
            if (folder.parent_id) {
                await this.recalculateFolderStats(folder.parent_id);
            }

            return { totalSize, fileCount, folderCount };
        } catch (error) {
            console.error(`Error recalculating folder stats: ${error.message}`);
            throw error;
        }
    }

    static async *streamFilesGenerator(userId, parentId = null) {
        try {
            // Stream folders using a Mongoose cursor
            const foldersStream = Folder.find({ userId, parent_id: parentId, deleted: false }).cursor();

            for await (const folder of foldersStream) {
                const childCount = await Folder.countDocuments({ parent_id: folder._id.toString(), deleted: false }) +
                    await File.countDocuments({ parent_id: folder._id.toString(), deleted: false });

                const isLocked = folder.isPasswordProtected &&
                    !folder.userAccess.some(access => access.userId === userId.toString());

                yield {
                    id: folder._id.toString(),
                    name: folder.name,
                    isFolder: true,
                    hasChildren: childCount > 0,
                    isLocked,
                    isPasswordProtected: folder.isPasswordProtected,
                    size: folder.size,  // Use the stored size from database
                    createdAt: folder.createdAt,
                    path: folder.path
                };
            }

            // Stream files using another Mongoose cursor
            const filesStream = File.find({ userId, parent_id: parentId, deleted: false }).cursor();

            for await (const file of filesStream) {
                const isLocked = file.isPasswordProtected &&
                    !file.userAccess.some(access => access.userId === userId.toString());

                yield {
                    id: file._id.toString(),
                    name: file.name,
                    isFolder: false,
                    size: file.size,
                    createdAt: file.createdAt,
                    mimetype: file.mimetype,
                    type: file.mimetype ? file.mimetype.split('/')[0] : 'unknown',
                    path: file.path,
                    isLocked,
                    isPasswordProtected: file.isPasswordProtected
                };
            }
        } catch (error) {
            console.error('Error streaming files:', error);
            throw new Error('Failed to stream files and folders');
        }
    }

    static async deleteFile(userId, fileId) {
        const file = await File.findOne({ _id: fileId, userId: userId });
        if (!file) {
            throw new Error('File not found');
        }
        const filePath = path.join(this.uploadDirectory, file.path);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`File physically deleted: ${filePath}`);
        }
        file.deleted = true; // Assuming you have a 'deleted' field
        await file.save();

        if (file.parent_id) {
            this.recalculateFolderStats(file.parent_id);
        }
    }

    static async deleteMultipleFiles(userId, ids, parentId) {
        // Find files and folders to be deleted
        const files = await File.find({ _id: { $in: ids }, userId: userId, deleted: false });
        const folders = await Folder.find({ _id: { $in: ids }, userId: userId, deleted: false });

        const deletionResults = {
            filesDeleted: 0,
            foldersDeleted: 0,
            errors: []
        };

        // Delete files
        for (const file of files) {
            try {
                if (!file.path) {
                    console.warn(`File path is undefined for file ID: ${file._id}`);
                    deletionResults.errors.push(`Invalid path for file: ${file.name}`);
                    continue;
                }

                const filePath = path.join(this.uploadDirectory, file.path);
                
                // Delete file from filesystem if it exists
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`File physically deleted: ${filePath}`);
                }

                // Mark file as deleted in database
                await File.updateOne({ _id: file._id }, { $set: { deleted: true } });
                console.log(`File marked as deleted in DB: ${file.path}`);
                deletionResults.filesDeleted++;
            } catch (error) {
                console.error(`Error deleting file: ${file.path}, Error: ${error.message}`);
                deletionResults.errors.push(`Failed to delete file: ${file.name}`);
            }
        }

        // Process folders and their contents
        for (const folder of folders) {
            try {
                if (!folder.path) {
                    console.warn(`Folder path is undefined for folder ID: ${folder._id}`);
                    deletionResults.errors.push(`Invalid path for folder: ${folder.name}`);
                    continue;
                }

                // Recursively delete folder and its contents
                await this.deleteFolderRecursively(folder._id, userId);
                console.log(`Folder and contents deleted: ${folder.path}`);
                deletionResults.foldersDeleted++;
            } catch (error) {
                console.error(`Error deleting folder: ${folder.path}, Error: ${error.message}`);
                deletionResults.errors.push(`Failed to delete folder: ${folder.name}`);
            }
        }

        // Recalculate parent folder stats if needed
        if (parentId) {
            try {
                await this.recalculateFolderStats(parentId);
            } catch (error) {
                console.error(`Error recalculating folder stats: ${error.message}`);
            }
        }

        return {
            success: deletionResults.errors.length === 0,
            ...deletionResults
        };
    }

    static async deleteFolderRecursively(folderId, userId) {
        try {
            // Find the folder to delete
            const folderToDelete = await Folder.findOne({ _id: folderId, userId });
            if (!folderToDelete) {
                throw new Error(`Folder with ID ${folderId} not found.`);
            }

            const folderPath = path.join(this.uploadDirectory, folderToDelete.path);

            // Find all subfolders and files
            const subFolders = await Folder.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                userId,
                deleted: false
            });
            const subFiles = await File.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                userId,
                deleted: false
            });

            // Mark all items as deleted in database
            await Folder.updateMany(
                { _id: { $in: [folderId, ...subFolders.map(f => f._id)] } },
                { $set: { deleted: true } }
            );
            await File.updateMany(
                { _id: { $in: subFiles.map(f => f._id) } },
                { $set: { deleted: true } }
            );

            // Delete the physical folder and all its contents
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`Folder physically deleted: ${folderPath}`);
            }

            console.log(`Folder ${folderToDelete.name} and its contents deleted completely.`);
            return { success: true };
        } catch (error) {
            console.error('Error in deleteFolderRecursively:', error);
            throw error;
        }
    }

    static async viewFile(userId, fileId) {
        const file = await this.getFileById(userId, fileId);
        
        if (!file) {
            throw new Error('File not found');
        }

        // Check if file is password protected and not recently verified by this user
        if (file.isPasswordProtected) {
            const userAccess = file.userAccess.find(
                access => access.userId === userId.toString()
            );
            
            const lastAccessed = userAccess ? new Date(userAccess.lastAccessed) : null;
            const now = new Date();
            
            // Check if user hasn't accessed in the last 30 minutes
            if (!lastAccessed || (now - lastAccessed) > 30 * 60 * 1000) {
                throw new Error('Password verification required');
            }
        }

        const filePath = path.join(this.uploadDirectory, file.path);
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found on disk');
        }

        const mimeType = mime.getType(filePath);
        return { filePath, mimeType };
    }

    static getFileStream(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found on disk');
        }
        return fs.createReadStream(filePath);
    }

    static async getFileById(userId, fileId) {
        const file = await File.findOne({ 
            _id: fileId, 
            userId: userId,
            deleted: false 
        });
        return file;
    }

    static async createFolder(userId, folderName, parent_id = null) {
        if (!userId || !folderName) {
            throw new Error('userId and folderName are required');
        }

        if (folderName.indexOf('..') > -1) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        // Determine the folder's relative path based on parent_id
        let folderPath = userId; // Start the path with userId as the base directory

        if (parent_id) {
            const parentFolder = await Folder.findById(parent_id);
            if (!parentFolder || parentFolder.userId !== userId) {
                throw new Error('Parent folder not found or access denied');
            }
            folderPath = path.join(parentFolder.path, folderName); // Path relative to parent folder
        } else {
            folderPath = path.join(userId, folderName); // Top-level folder under user’s directory
        }

        const fullPath = path.join(FileService.uploadDirectory, folderPath); // Full path for filesystem

        // Create the directory in the filesystem
        fs.mkdirSync(fullPath, { recursive: true });

        // Save folder information in the database
        const newFolder = new Folder({
            userId,
            parent_id: parent_id,
            name: folderName,
            path: folderPath, // Save as relative path including userId
            createdAt: new Date()
        });

        await newFolder.save();

        return newFolder;
    }

    static async compressFiles(userId, items, folder = '', zipFileName = null, parentId = null, progressCallback = null, archiveType = 'zip', compressionLevel = 6) {
        // Validate items exist and user has access
        const validatedItems = [];
        const affectedFolders = new Set(); // Track folders that need size recalculation

        for (const itemId of items) {
            try {
                let item;
                let itemPath;
                let itemType;
                let itemName;
                let itemParentId;

                // Try to find the item as a file first
                const file = await File.findById(itemId);
                if (file && file.userId.toString() === userId) {
                    itemType = 'file';
                    itemPath = path.join(this.uploadDirectory, file.path);
                    itemName = file.name;
                    itemParentId = file.parent_id;
                } else {
                    // If not found as file, try as a folder
                    const folder = await Folder.findById(itemId);
                    if (folder && folder.userId.toString() === userId) {
                        itemType = 'folder';
                        itemPath = path.join(this.uploadDirectory, folder.path);
                        itemName = folder.name;
                        itemParentId = folder.parent_id;
                    } else {
                        throw new Error(`Item not found or access denied: ${itemId}`);
                    }
                }

                // Add parent folder to affected folders list
                if (itemParentId) {
                    affectedFolders.add(itemParentId.toString());
                }

                // Verify path exists
                if (!fs.existsSync(itemPath)) {
                    throw new Error(`Path not found for ${itemName}: ${itemPath}`);
                }

                validatedItems.push({
                    id: itemId,
                    type: itemType,
                    name: itemName,
                    fullPath: itemPath
                });
            } catch (error) {
                console.error(`Error validating item ${itemId}:`, error);
                throw error;
            }
        }

        if (!folder) {
            folder = '';
            parentId = null;
        }

        const key = `${userId}-${zipFileName}`;
        const abortController = new AbortController();
        this.ongoingCompressions.set(key, { abortController, activeArchive: null, output: null });

        const signal = abortController.signal;

        signal.addEventListener('abort', () => {
            console.log(`Aborting compression for ${zipFileName}.`);
            if (archive) archive.abort();
            if (output) {
                output.destroy();
                if (fs.existsSync(zipFilePath)) {
                    fs.unlink(zipFilePath, (err) => {
                        if (err) console.error(`Error deleting partial ZIP file: ${err.message}`);
                    });
                }
            }
        });

        // Determine file extension and mime type based on archive type
        let fileExtension, mimeType, sevenZFormat;
        switch (archiveType.toLowerCase()) {
            case '7z':
                fileExtension = '.7z';
                mimeType = 'application/x-7z-compressed';
                sevenZFormat = '7z';
                break;
            case 'tgz':
                fileExtension = '.tar.gz';
                mimeType = 'application/gzip';
                sevenZFormat = 'tgz';
                break;
            case 'zip':
            default:
                fileExtension = '.zip';
                mimeType = 'application/zip';
                sevenZFormat = 'zip';
        }

        const timestamp = Date.now();
        const name = zipFileName || `compressed_${timestamp}${fileExtension}`;
        const targetFolder = path.join(this.uploadDirectory, userId, folder);
        const zipFilePath = path.join(targetFolder, name);

        if (!fs.existsSync(targetFolder)) {
            fs.mkdirpSync(targetFolder);
        }

        const filePaths = validatedItems.map(item => item.fullPath);

        try {
            const result = await CompressionService.compressFiles(filePaths, zipFilePath, archiveType, compressionLevel, progressCallback);
            
            const compressedFile = new File({
                name,
                path: path.join(userId, folder, name),
                size: result.archiveSize,
                mimetype: mimeType,
                createdAt: new Date(),
                deleted: false,
                userId: userId,
                parent_id: parentId
            });

            await compressedFile.save();

            // Recalculate sizes for all affected folders
            for (const folderId of affectedFolders) {
                await this.recalculateFolderStats(folderId);
            }

            // If the compressed file was saved to a folder, recalculate that folder's size too
            if (parentId) {
                await this.recalculateFolderStats(parentId);
            }

            return { success: true, file: compressedFile };
        } catch (error) {
            console.error('Error in compression process:', error);
            if (fs.existsSync(zipFilePath)) {
                fs.unlink(zipFilePath, () => {});
            }
            this.ongoingCompressions.delete(key);
            throw error;
        }
    }

    static async decompressFile(userId, zipFilePath, targetFolder = '.', parentId = null) {
        const rootDir = path.resolve(`${this.uploadDirectory}/${userId}`);
        let targetDir;

        if (parentId) {
            // If parentId is provided, get the folder's path from the database
            const parentFolder = await Folder.findById(parentId);
            if (!parentFolder) {
                throw new Error('Parent folder not found');
            }
            targetDir = path.join(this.uploadDirectory, parentFolder.path);
        } else {
            // If no parentId, use the root directory
            targetDir = rootDir;
        }

        zipFilePath = path.join(this.uploadDirectory, zipFilePath);

        // Prevent directory traversal attack
        if (!targetDir.startsWith(rootDir)) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        const isRoot = targetDir === rootDir;

        if (!isRoot) {
            // Ensure the target directory exists
            fs.mkdirSync(targetDir, {recursive: true});
        }

        const extractedItems = [];

        await extract(zipFilePath, {
            dir: targetDir,
            onEntry: async (entry) => {
                extractedItems.push(entry.fileName);
            },
        });

        // Save extracted contents
        await this.saveExtractedContentsInDb(rootDir, targetDir, userId, parentId, isRoot, extractedItems);

        // Recalculate folder size after decompression
        if (parentId) {
            await this.recalculateFolderStats(parentId);
        }

        return path.relative(this.uploadDirectory, targetDir);
    }

    static async stopCompression(userId, zipFileName) {
        const key = `${userId}-${zipFileName}`;
        const compression = this.ongoingCompressions.get(key);

        if (compression) {
            const { abortController, activeArchive, output } = compression;

            try {
                // Kill the compression process first
                const killed = CompressionService.killCurrentProcess();
                console.log('Compression process killed:', killed);

                if (activeArchive) {
                    activeArchive.abort(); // Stop the archiver process
                }

                if (output) {
                    output.destroy(); // Close the output stream
                }

                if (abortController) {
                    abortController.abort(); // Signal other components to stop
                }

                // Delete the partial zip file if it exists
                const zipFilePath = path.join(this.uploadDirectory, userId, zipFileName);
                if (fs.existsSync(zipFilePath)) {
                    await fs.unlink(zipFilePath);
                }

                this.ongoingCompressions.delete(key);
                console.log(`Stopped compression for ${zipFileName}.`);
                return true;
            } catch (error) {
                console.error(`Error stopping compression for ${zipFileName}:`, error);
                throw error;
            }
        }

        console.log(`No ongoing compression found for ${zipFileName}.`);
        return false;
    }

    static async saveExtractedContentsInDb(rootDir, currentPath, userId, parentFolderId = null, isRoot = false, items = []) {
        // Calculate the relative path from the root directory
        const relativeFolderPath = path.relative(rootDir, currentPath);
        const fullFolderPath = isRoot
            ? userId // If root, only use the userId as the base path
            : path.join(userId, relativeFolderPath); // Prefix with userId for non-root folders

        let folderDoc;

        // Only create a folder if it’s not the root or explicitly required
        if (!isRoot || relativeFolderPath) {
            folderDoc = await Folder.findOne({ path: fullFolderPath, userId, deleted: false });

            if (!folderDoc) {
                folderDoc = new Folder({
                    name: isRoot ? userId : path.basename(currentPath), // Use userId only for root
                    path: fullFolderPath,
                    parent_id: isRoot ? null : parentFolderId, // Root has no parent
                    userId,
                });
                await folderDoc.save();
            }

            // Update parentFolderId for nested items
            parentFolderId = folderDoc._id;
        }

        for (const item of items) {
            const absoluteItemPath = path.join(currentPath, item);
            const stats = fs.statSync(absoluteItemPath);

            if (stats.isDirectory()) {
                // Recursively handle subdirectories
                await this.saveExtractedContentsInDb(
                    rootDir,
                    absoluteItemPath,
                    userId,
                    parentFolderId,
                    false // Subdirectories are not root
                );
            } else {
                // Handle files
                const relativeFilePath = path.relative(rootDir, absoluteItemPath);
                const fullFilePath = path.join(userId, relativeFilePath); // Prefix with userId for full path

                // Get relative folder path and remove file name
                let folderDbRelativePath = relativeFilePath.split('/');
                folderDbRelativePath.pop();
                folderDbRelativePath = path.join(userId, folderDbRelativePath.join('/'));

                folderDoc = await Folder.findOne({ path: folderDbRelativePath, userId, deleted: false });

                // Check or create the file document
                let fileDoc = await File.findOne({ path: fullFilePath, userId, deleted: false });
                if (!fileDoc) {
                    const mimeType = mime.getType(absoluteItemPath) || 'application/octet-stream';

                    fileDoc = new File({
                        name: path.basename(absoluteItemPath),
                        path: fullFilePath,
                        parent_id: folderDoc ? folderDoc._id : parentFolderId,
                        size: stats.size,
                        mimetype: mimeType,
                        userId,
                    });
                    await fileDoc.save();
                }
            }
        }
    }

    static async saveFileMetadata(targetPath, userId, filename, parentId, relativeUploadDir, writeStream)
    {
        if (!parentId) {
            parentId = null;
        }

        if (!relativeUploadDir) {
            relativeUploadDir = userId;
        }

        return new Promise((resolve, reject) => {
            writeStream.on('finish', async () => {
                await fs.stat(targetPath, async (err, stats) => {
                    if (err) {
                        console.error('Error fetching file stats:', err);
                        reject(err);
                    } else {
                        // Save metadata to the database
                        // const stats = fs.statSync(targetPath);
                        const mimeType = mime.getType(targetPath);

                        const file = new File({
                            userId,
                            name: filename,
                            parent_id: parentId,
                            path: path.join(relativeUploadDir, filename),
                            size: stats.size,
                            mimetype: mimeType,
                            createdAt: new Date(),
                            deleted: false,
                        });

                        await file.save();

                        resolve(file);
                    }
                });
            });
        });
    }

    static async renameItem(userId, itemId, newName, isFolder) {
        if (!userId || !itemId || !newName) {
            throw new Error('userId, itemId, and newName are required');
        }

        if (newName.indexOf('..') > -1) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        let item, oldPath, newPath;

        if (isFolder) {
            // Find the folder by ID
            item = await Folder.findOnBy({ _id: itemId, userId });
            if (!item) throw new Error('Folder not found or access denied');

            // Set old and new paths for renaming
            oldPath = item.path;
            newPath = path.join(path.dirname(oldPath), newName);

            // Rename the folder in the filesystem
            await fs.renameSync(
                path.join(this.uploadDirectory, oldPath),
                path.join(this.uploadDirectory, newPath)
            );

            // Update the folder's own path in the database
            item.name = newName;
            item.path = newPath;
            await item.save();

            // Update all child folders and files with paths that start with the old path
            const oldPathSegment = oldPath;
            const newPathSegment = newPath;

            // Find and update child folders
            const childFolders = await Folder.find({ userId, path: new RegExp(`^${oldPathSegment}/`) });
            const updateFolderPromises = childFolders.map(folder => {
                folder.path = folder.path.replace(oldPathSegment, newPathSegment);
                return folder.save();
            });

            // Find and update child files
            const childFiles = await File.find({ userId, path: new RegExp(`^${oldPathSegment}/`)});
            const updateFilePromises = childFiles.map(file => {
                file.path = file.path.replace(oldPathSegment, newPathSegment);
                return file.save();
            });

            // Execute updates in parallel
            await Promise.all([...updateFolderPromises, ...updateFilePromises]);

        } else {
            // Find the file by ID
            item = await File.findBy({ _id: itemId, userId });
            if (!item || item.userId !== userId) throw new Error('File not found or access denied');

            // Set old and new paths for renaming
            oldPath = item.path;
            newPath = path.join(path.dirname(oldPath), newName);

            // Rename the file in the filesystem
            fs.renameSync(
                path.join(this.uploadDirectory, oldPath),
                path.join(this.uploadDirectory, newPath)
            );

            // Update the file's name and path in the database
            item.name = newName;
            item.path = newPath;
            await item.save();
        }

        return `${isFolder ? 'Folder' : 'File'} renamed successfully`;
    }

    static async moveItems(userId, itemIds, targetFolderId, progressCallback) {
        let targetFolder;

        // Validate the target folder
        if (!targetFolderId || targetFolderId === 'root') {
            targetFolder = {path: userId};
        } else {
            targetFolder = await Folder.findById(targetFolderId);
        }

        const totalItems = itemIds.length;
        let processedItems = 0;

        for (const itemId of itemIds) {
            // Find the item to move (file or folder)
            let item = await File.findById(itemId) || await Folder.findById(itemId);
            if (!item) {
                console.warn(`Item with ID ${itemId} not found. Skipping.`);
                continue;
            }

            // Define old and new paths
            const oldPath = item.path;
            const newPath = path.join(targetFolder.path, item.name);

            // Move the item on the filesystem
            await fs.move(
                path.join(this.uploadDirectory, oldPath),
                path.join(this.uploadDirectory, newPath),
                {overwrite: false}
            );

            // Update item's `parent_id` and `path` in the database
            item.parent_id = targetFolderId === 'root' ? null : targetFolderId;
            item.path = newPath;
            await item.save();

            // If the item is a folder, update the paths of all child items
            if (item instanceof Folder) {
                const oldPathSegment = oldPath;
                const newPathSegment = newPath;

                // Update paths of child folders
                const childFolders = await Folder.find({path: new RegExp(`^${oldPathSegment}/`)});
                for (const childFolder of childFolders) {
                    childFolder.path = childFolder.path.replace(oldPathSegment, newPathSegment);
                    await childFolder.save();
                }

                // Update paths of child files
                const childFiles = await File.find({path: new RegExp(`^${oldPathSegment}/`)});
                for (const childFile of childFiles) {
                    childFile.path = childFile.path.replace(oldPathSegment, newPathSegment);
                    await childFile.save();
                }
            }

            if (progressCallback && typeof progressCallback === 'function') {
                const progress = Math.round((processedItems / totalItems) * 100);
                progressCallback(item.name, progress);
            }

            console.log(`Moved item: ${item.name}`);
        }

        // Recalculate stats for the target folder
        await this.recalculateFolderStats(targetFolderId);

        return {message: 'Items moved successfully'};
    }

    static async moveItemsIntoZip(userId, itemIds, zipFileId) {
        try {
            const zipFile = await File.findOne({ _id: zipFileId, userId, deleted: false });
            if (!zipFile || zipFile.mimetype !== 'application/zip') {
                throw new Error('Target file is not a valid ZIP file.');
            }

            const zipFilePath = path.join(this.uploadDirectory, zipFile.path);
            const tmpZipFilePath = `${zipFilePath}.tmp`;

            const output = fs.createWriteStream(tmpZipFilePath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            archive.pipe(output);

            console.log('Reading existing ZIP contents...');
            const existingZip = new AdmZip(zipFilePath);
            const existingEntries = existingZip.getEntries();

            for (const entry of existingEntries) {
                if (!entry.isDirectory) {
                    console.log(`Adding existing ZIP entry: ${entry.entryName}`);
                    archive.append(existingZip.readFile(entry), { name: entry.entryName });
                }
            }

            for (const itemId of itemIds) {
                const item = await File.findOne({ _id: itemId, userId, deleted: false })
                    || await Folder.findOne({ _id: itemId, userId, deleted: false });

                if (!item) {
                    console.warn(`Item with ID ${itemId} not found. Skipping.`);
                    continue;
                }

                const itemPath = path.join(this.uploadDirectory, item.path);

                if (!fs.existsSync(itemPath)) {
                    console.warn(`Item path ${itemPath} does not exist. Skipping.`);
                    continue;
                }

                if (fs.statSync(itemPath).isDirectory()) {
                    console.log(`Adding folder to ZIP: ${item.name}`);
                    await this.addFolderToArchive(archive, itemPath, item.name);
                    await this.deleteFolderAndContents(itemId);
                } else {
                    console.log(`Streaming file to ZIP: ${item.name}`);
                    try {
                        const fileStream = fs.createReadStream(itemPath);
                        archive.append(fileStream, { name: item.name });
                        console.log(`File successfully queued: ${item.name}`);

                        // Delete the file after it has been added to the archive
                        fs.unlinkSync(itemPath);
                    } catch (err) {
                        console.error(`Error adding file to ZIP: ${err.message}`);
                    }
                }
            }

            console.log('Finalizing archive...');
            await this.finalizeArchiveWithTimeout(archive, 30000); // 30-second timeout

            console.log('Replacing original ZIP file...');
            fs.renameSync(tmpZipFilePath, zipFilePath);

            return { message: 'Items moved into ZIP file successfully' };
        } catch (error) {
            console.error('Error moving items into ZIP file:', error.message);
            throw new Error('Failed to move items into ZIP file');
        }
    }

    // Helper Method: Add Folder and Its Contents to Archive
    static async addFolderToArchive(archive, folderPath, folderName) {
        const items = fs.readdirSync(folderPath);

        for (const item of items) {
            const itemPath = path.join(folderPath, item);

            if (!fs.existsSync(itemPath)) {
                console.warn(`Sub-item path ${itemPath} does not exist. Skipping.`);
                continue;
            }

            if (fs.statSync(itemPath).isDirectory()) {
                console.log(`Adding subfolder to ZIP: ${path.join(folderName, item)}`);
                await this.addFolderToArchive(archive, itemPath, path.join(folderName, item));
            } else {
                console.log(`Streaming file to ZIP: ${path.join(folderName, item)}`);
                try {
                    const fileStream = fs.createReadStream(itemPath);
                    archive.append(fileStream, { name: path.join(folderName, item) });
                } catch (err) {
                    console.error(`Error adding file to ZIP: ${err.message}`);
                }
            }
        }
    }

    // Helper Method: Finalize Archive with Timeout
    static async finalizeArchiveWithTimeout(archive, timeout) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                console.error('Finalization timeout exceeded.');
                reject(new Error('Archive finalization timed out.'));
            }, timeout);

            archive.on('error', (err) => {
                clearTimeout(timeoutId);
                console.error('Error during finalization:', err);
                reject(err);
            });

            archive.finalize().then(() => {
                clearTimeout(timeoutId);
                console.log('Archive finalized successfully.');
                resolve();
            }).catch((err) => {
                clearTimeout(timeoutId);
                console.error('Finalization failed:', err);
                reject(err);
            });
        });
    }

    // Helper Method: Delete Folder and Its Contents
    static async deleteFolderAndContents(folderId) {
        const folder = await Folder.findOne({ _id: folderId, deleted: false });
        if (!folder) return;

        const folderPath = path.join(this.uploadDirectory, folder.path);

        // Get all files and subfolders inside the folder
        const files = await File.find({ parent_id: folderId, deleted: false });
        const subfolders = await Folder.find({ parent_id: folderId, deleted: false });

        // Delete all files in the folder
        for (const file of files) {
            const filePath = path.join(this.uploadDirectory, file.path);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            await File.deleteOne({ _id: file._id });
        }

        // Recursively delete all subfolders
        for (const subfolder of subfolders) {
            await this.deleteFolderAndContents(subfolder._id);
        }

        // Delete the folder itself from disk and database
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }
        await Folder.deleteOne({ _id: folderId });
    }

    static prepareDownload(filePath) {
        const absolutePath = path.join(this.uploadDirectory, filePath);
        if (!fs.existsSync(absolutePath)) {
            throw new Error('File does not exist.');
        }
        return absolutePath;
    }

    static async processChunkAndTrackProgress(userId, filename, folderId, chunk, currentChunk, totalChunks) {
        try {
            // Process the uploaded chunk (store to disk or database)
            await this.uploadFile(userId, filename, folderId, chunk, currentChunk, totalChunks);

            // Track uploaded chunk progress
            const chunkIndex = parseInt(currentChunk, 10);

            let uploadProgress = await UploadProgress.findOne({ filename, userId });

            if (!uploadProgress) {
                uploadProgress = new UploadProgress({ userId, filename, uploadedChunks: [] });
            }

            if (!uploadProgress.uploadedChunks.includes(chunkIndex)) {
                uploadProgress.uploadedChunks.push(chunkIndex);
                await uploadProgress.save();
            }

            if (currentChunk >= totalChunks && uploadProgress) {
                uploadProgress.delete();
            }
        } catch (error) {
            console.error('Error processing chunk or tracking progress:', error.message);
            throw new Error('Failed to process chunk or track progress');
        }
    }

    static async getUploadedChunks(filename, userId) {
        try {
            // Fetch upload progress from the database or storage system
            const uploadProgress = await UploadProgress.findOne({ filename, userId });

            if (!uploadProgress) {
                return null; // No progress found for the file
            }

            return uploadProgress.uploadedChunks; // Return the list of uploaded chunks
        } catch (error) {
            console.error('Error retrieving uploaded chunks:', error.message);
            throw new Error('Failed to retrieve upload progress.');
        }
    }

    static async getFolderTree(userId, parentId = null, isRoot = true) {
        try {
            if (parentId === 'root') {
                parentId = null;
                isRoot = true;
            }

            // Fetch folders for the current parent
            const folders = await Folder.find({ userId, parent_id: parentId, deleted: false }).lean();

            // Construct the tree for each folder
            const tree = await Promise.all(folders.map(async (folder) => {
                // Only check for subfolders in tree mode
                const subfolderCount = await Folder.countDocuments({ 
                    userId, 
                    parent_id: folder._id.toString(), 
                    deleted: false 
                });

                const children = await this.getFolderTree(userId, folder._id, false); // Recursive call to get child folders
                return {
                    id: folder._id,
                    text: folder.name,
                    expanded: false,
                    children: children.length > 0 ? children : [],
                    parentId: folder.parent_id,
                    leaf: subfolderCount === 0 // Leaf if no subfolders
                };
            }));

            return tree;
        } catch (error) {
            console.error('Error in getFolderTree:', error.message);
            throw new Error('Failed to construct folder tree');
        }
    }

    static async setPassword(userId, itemId, password, isFolder) {
        try {
            const Model = isFolder ? Folder : File;
            const item = await Model.findOne({ _id: itemId, userId, deleted: false });

            if (!item) {
                throw new Error('Item not found');
            }

            // Hash the password before storing
            const hashedPassword = await bcrypt.hash(password, 10);

            item.isPasswordProtected = true;
            item.password = hashedPassword;
            await item.save();

            return { success: true };
        } catch (error) {
            console.error('Error setting password:', error.message);
            throw error;
        }
    }

    static async removePassword(userId, itemId, currentPassword, isFolder) {
        try {
            const Model = isFolder ? Folder : File;
            const item = await Model.findOne({ _id: itemId, userId, deleted: false }).select('+password');

            if (!item) {
                throw new Error('Item not found');
            }

            const isMatch = await bcrypt.compare(currentPassword, item.password);
            if (!isMatch) {
                throw new Error('Invalid password');
            }

            item.isPasswordProtected = false;
            item.password = undefined;
            item.isPasswordProtected = false; // Reset canRemovePassword after removing password
            await item.save();

            return { success: true };
        } catch (error) {
            console.error('Error removing password:', error.message);
            throw error;
        }
    }

    static async verifyPassword(userId, itemId, password, isFolder) {
        if (!itemId || !password) {
            return false;
        }

        try {
            if (isFolder) {
                const folder = await Folder.findOne({ _id: itemId, deleted: false }).select('+password');
                if (!folder || !folder.isPasswordProtected) {
                    return false;
                }
                
                const isValid = await bcrypt.compare(password, folder.password);
                if (!isValid) {
                    return false;
                }
                
                // Update or add user access record for folder
                const userAccessIndex = folder.userAccess.findIndex(
                    access => access.userId === userId.toString()
                );
                
                if (userAccessIndex >= 0) {
                    folder.userAccess[userAccessIndex].lastAccessed = new Date();
                } else {
                    folder.userAccess.push({
                        userId,
                        lastAccessed: new Date()
                    });
                }
                
                await folder.save();
            } else {
                const file = await File.findOne({ _id: itemId, deleted: false }).select('+password');
                if (!file || !file.isPasswordProtected) {
                    return false;
                }
                
                const isValid = await bcrypt.compare(password, file.password);
                if (!isValid) {
                    return false;
                }
                
                // Update or add user access record for file
                const userAccessIndex = file.userAccess.findIndex(
                    access => access.userId === userId.toString()
                );
                
                if (userAccessIndex >= 0) {
                    file.userAccess[userAccessIndex].lastAccessed = new Date();
                } else {
                    file.userAccess.push({
                        userId,
                        lastAccessed: new Date()
                    });
                }
                
                await file.save();
            }
            
            return true;
        } catch (error) {
            console.error('Error in verifyPassword:', error);
            return false;
        }
    }

    static async getMimeType(filePath) {
        const mimeType = mime.getType(filePath);
        return { filePath, mimeType };
    }
}

module.exports = FileService;
