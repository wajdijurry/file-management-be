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

    // Method to calculate the size of a folder recursively
    // static calculateFolderSize(folderPath) {
    //     let totalSize = 0;
    //
    //     const items = fs.readdirSync(folderPath);
    //     items.forEach(item => {
    //         const itemPath = path.join(folderPath, item);
    //         const stats = fs.statSync(itemPath);
    //
    //         if (stats.isDirectory()) {
    //             // Recursively calculate the size of subdirectories
    //             totalSize += FileService.calculateFolderSize(itemPath);
    //         } else {
    //             // Add the size of the file
    //             totalSize += stats.size;
    //         }
    //     });
    //
    //     return totalSize;
    // }

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

        items.forEach((item) => {
            const itemPath = path.join(this.uploadDirectory, userId, item);
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                // If the item is a folder, calculate the size of its contents recursively
                totalSize += this.calculateFolderSize(itemPath);
            } else {
                totalSize += stats.size;
            }
        });

        return totalSize;
    }

    static async getFiles(userId, parentId = null) {
        // Fetch folders and files from the database based on parent_id
        const folderRecords = await Folder.find({
            userId: userId,
            parent_id: parentId,
            deleted: false
        }).exec();

        const fileRecords = await File.find({
            userId: userId,
            parent_id: parentId,
            deleted: false
        }).exec();

        // Set the target path based on parentId, defaulting to the root upload directory
        let uploadDirectory = this.uploadDirectory;

        // Build the response data by fetching folders and files from disk
        const filesAndFolders = await Promise.all([
            ...folderRecords.map(async folderRecord => {
                const folderPath = path.join(uploadDirectory, folderRecord.path);
                if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
                    return null; // Ignore if the folder does not exist on disk
                }

                // Calculate folder size recursively if needed
                const folderSize = FileService.calculateFolderSize(folderPath);
                const stats = fs.statSync(folderPath);

                return {
                    _id: folderRecord._id,
                    name: folderRecord.name,
                    isFolder: true,
                    size: folderSize,
                    createdAt: stats.ctime,
                    mimetype: '',
                    fileCount: folderRecord.fileCount || 0,
                    folderCount: folderRecord.folderCount || 0,
                    path: folderRecord.path
                };
            }),
            ...fileRecords.map(fileRecord => {
                const filePath = path.join(uploadDirectory, fileRecord.path);
                if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                    return null; // Ignore if the file does not exist on disk
                }

                return {
                    _id: fileRecord._id,
                    name: fileRecord.name,
                    isFolder: false,
                    size: fileRecord.size,
                    createdAt: fileRecord.createdAt,
                    mimetype: fileRecord.mimetype,
                    path: fileRecord.path
                };
            })
        ]);

        // Filter out any null entries (e.g., missing files or folders on disk)
        return filesAndFolders.filter(item => item);
    }

    static async getFileById(userId, id) {
        return File.findOne({ _id: id, userId: userId, deleted: false });
    }

    static async getFile(userId, fileId) {
        const file = await this.getFileById(userId, fileId);

        if (!file) {
            console.error(`File record not found in database for ID: ${fileId}`);
            throw new Error('File not found');
        }

        let filePath = path.join(this.uploadDirectory, file.path);

        if (!fs.existsSync(filePath)) {
            console.error(`File does not exist on disk: ${filePath}`);
            throw new Error('File not found');
        }

        return filePath;
    }

    static async getFileStream(filePath) {
        return fs.createReadStream(filePath);
    }

    static async deleteFile(userId, fileId) {
        const file = await File.findOne({ _id: fileId, userId: userId });
        if (!file) {
            throw new Error('File not found');
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
            foldersDeleted: 0
        };

        // Update database to remove documents recursively
        const deleteDbRecords = async (parentId) => {
            // Find all child folders and files
            const childFiles = await File.find({ parentId, userId, deleted: false });
            const childFolders = await Folder.find({ parentId, userId, deleted: false });

            for (const file of childFiles) {
                await File.updateOne({ _id: file._id }, { $set: { deleted: true } });
                deletionResults.filesDeleted++;
            }

            for (const folder of childFolders) {
                await deleteDbRecords(folder._id); // Recursively delete child folder contents
                await Folder.updateOne({ _id: folder._id }, { $set: { deleted: true } });
                deletionResults.foldersDeleted++;
            }
        };

        for (const file of files) {
            if (file.path) { // Ensure the path is defined
                const filePath = path.join(this.uploadDirectory, file.path);
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`File deleted: ${filePath}`);
                        deletionResults.filesDeleted++;
                    } catch (error) {
                        console.error(`Error deleting file: ${filePath}, Error: ${error.message}`);
                    }
                }
            } else {
                console.warn(`File path is undefined for file ID: ${file._id}`);
            }
        }

        for (const folder of folders) {
            if (folder.path) { // Ensure the path is defined
                const folderPath = path.join(this.uploadDirectory, folder.path);
                try {
                    await this.deleteFolderRecursively(folder._id, userId);
                } catch (error) {
                    console.error(`Error deleting folder: ${folderPath}, Error: ${error.message}`);
                }
            } else {
                console.warn(`Folder path is undefined for folder ID: ${folder._id}`);
            }
        }

        this.recalculateFolderStats(parentId);

        return deletionResults.filesDeleted + deletionResults.foldersDeleted;
    }

    static async deleteFolderRecursively(folderId, userId) {
        try {
            // Find the folder to delete
            const folderToDelete = await Folder.findOne({ _id: folderId, userId });

            if (!folderToDelete) {
                throw new Error(`Folder with ID ${folderId} not found.`);
            }

            // Recursively find all subfolders and files within the specified folder
            const subFolders = await Folder.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                userId
            });
            const subFolderIds = subFolders.map(folder => folder._id);

            // Find all files within the folder and its subfolders
            const filesToDelete = await File.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                userId
            });
            const fileIds = filesToDelete.map(file => file._id);

            // Delete all subfolder and file documents in one go
            await Folder.updateMany({ _id: { $in: [folderId, ...subFolderIds] } }, { $set: { deleted: true } });
            await File.updateMany({ _id: { $in: fileIds } }, { $set: { deleted: true } });

            console.log(`Deleted folder ${folderToDelete.name} and its contents.`);

            // Delete folders and files from filesystem
            const folderPath = path.join(this.uploadDirectory, folderToDelete.path);
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`Deleted folder and all contents from filesystem at ${folderPath}`);
            }

            return { message: 'Folder and all its contents deleted successfully.' };
        } catch (error) {
            console.error('Error deleting folder recursively:', error);
            throw new Error('Failed to delete folder and its contents.');
        }
    }

    static async viewFile(userId, fileId) {
        const filePath = await this.getFile(userId, fileId);
        const mimeType = mime.getType(filePath);
        return { filePath, mimeType };
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

    static async compressFiles(userId, items, folder = '', zipFileName = null, parentId = null, progressCallback = null) {
        if (!folder) {
            folder = '';
        }

        if (!parentId) {
            parentId = null;
        }

        const key = `${userId}-${zipFileName}`;
        const abortController = new AbortController();
        this.ongoingCompressions.set(key, { abortController, activeArchive: null, output: null });

        const signal = abortController.signal;
        let output, archive;

        signal.addEventListener('abort', () => {
            console.log(`Aborting compression for ${zipFileName}.`);
            archive.abort();
            if (output) {
                output.destroy();
                fs.unlink(zipFilePath, (err) => {
                    if (err) console.error(`Error deleting partial ZIP file: ${err.message}`);
                });
            }
        });

        const timestamp = Date.now();
        const name = zipFileName || `compressed_${timestamp}.zip`; // Use provided name or default
        const targetFolder = path.join(this.uploadDirectory, userId, folder);
        const zipFilePath = path.join(targetFolder, name);

        if (!fs.existsSync(targetFolder)) {
            throw new Error("The specified folder doesn't exist.");
        }

        return new Promise(async (resolve, reject) => {
            output = fs.createWriteStream(zipFilePath);
            archive = archiver('zip', { zlib: { level: 9 } });
            this.ongoingCompressions.get(key).activeArchive = archive;
            this.ongoingCompressions.get(key).output = output;
            // let processedFiles = 0;
            // let totalBytes = 0;
            let processedBytes = 0;

            signal.addEventListener('abort', () => {
                console.log(`Compression for ${zipFileName} aborted.`);
                archive.abort(); // Abort archiving
                output.destroy(); // Forcefully close the output stream
                fs.unlink(zipFilePath, (err) => {
                    if (err) console.error(`Error deleting partial ZIP file: ${err.message}`);
                });
            });

            output.on('close', async () => {
                try {
                    const stats = fs.statSync(zipFilePath);

                    // Attempt to create a new File record for the compressed file
                    const compressedFile = new File({
                        name,
                        path: path.join(userId, folder, name),
                        size: stats.size,
                        mimetype: 'application/zip',
                        createdAt: new Date(),
                        deleted: false,
                        userId: userId,
                        parent_id: parentId
                    });

                    await compressedFile.save();

                    resolve(compressedFile);
                } catch (error) {
                    if (signal.aborted) {
                        console.log(`Compression for ${zipFileName} was aborted successfully.`);
                    } else {
                        console.error('Error saving metadata:', error);
                    }
                    reject(new Error('Failed to save compressed file metadata: ' + error.message));
                }
            });

            output.on('error', (err) => {
                console.error('Error during compression:', err); // Log compression error
                reject(new Error('Failed to compress files: ' + err.message));
            });

            archive.on('error', (err) => {
                console.error('Archive error:', err);
                reject(new Error('Archive error: ' + err.message));
            });

            // archive.on('progress', (progressData) => {
                // if (progressCallback && typeof progressCallback === 'function') {
                //     if (!totalBytes) {
                //         // Calculate total bytes once, using the total size of all items
                //         totalBytes = items.reduce((sum, item) => {
                //             const itemPath = path.join(this.uploadDirectory, userId, item);
                //             return sum + fs.statSync(itemPath).size;
                //         }, 0);
                //     }
                //
                //     // Calculate progress based on compressed bytes
                //     const compressedBytes = progressData.fs.processedBytes;
                //     const progress = Math.round((compressedBytes / totalBytes) * 100);
                //     // const progress = Math.round((progressData.entries.processed / items.length) * 100);
                //     progressCallback(progress);
                // }
            // });

            // Calculate total bytes for all items
            let totalSize = this.calculateTotalSize(items, userId);

            // Listen for 'data' event to track compressed bytes
            archive.on('data', (chunk) => {
                processedBytes += chunk.length;
                if (progressCallback && typeof progressCallback === 'function') {
                    const progress = Math.round((processedBytes / totalSize) * 100);
                    progressCallback(progress);
                }
            });

            archive.pipe(output);

            // items.forEach(item => {
            //     const itemPath = path.join(this.uploadDirectory, userId, item);
            //     if (fs.statSync(itemPath).isDirectory()) {
            //         archive.directory(itemPath, item);
            //     } else {
            //         archive.file(itemPath, { name: item });
            //     }
            //     processedFiles++;
            // });

            items.forEach((item) => {
                if (signal.aborted) {
                    console.log('Aborting compression process...');
                    throw new Error('Compression process aborted');
                }
                const itemPath = path.join(this.uploadDirectory, userId, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    archive.directory(itemPath, item);
                } else {
                    archive.file(itemPath, { name: item });
                }
            });

            await archive.finalize();

            this.ongoingCompressions.delete(key);

            this.recalculateFolderStats(parentId);
        });
    }

    static async decompressFile(userId, zipFilePath, targetFolder = '.', parentId = null) {
        const rootDir = path.resolve(`${this.uploadDirectory}/${userId}`);
        let targetDir = targetFolder === '.' ? rootDir : path.join(rootDir, targetFolder);
        parentId = parentId ? parentId : null;

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
                const fullPath = path.join(targetDir, entry.fileName);
                const relativePath = path.relative(rootDir, fullPath);

                const parts = relativePath.split('/');
                const segments = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
                for (const part of segments) {
                    extractedItems.push(part);
                }
            },
        });

        // Save extracted contents
        await this.saveExtractedContentsInDb(rootDir, targetDir, userId, parentId, isRoot, extractedItems);

        return path.relative(this.uploadDirectory, targetDir);
    }

    static async stopCompression(userId, zipFileName) {
        const key = `${userId}-${zipFileName}`;
        const compression = this.ongoingCompressions.get(key);

        if (compression) {
            const { abortController, archive } = compression;

            if (archive) {
                archive.abort(); // Stop the archiver process
            }

            if (abortController) {
                abortController.abort(); // Signal other components to stop
            }

            this.ongoingCompressions.delete(key);
            console.log(`Stopped compression for ${zipFileName}.`);
            return true;
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

        if (!isRoot) {
            // If not root, remove the first item (folder) as it is already created
            currentPath = currentPath.split('/');
            currentPath = currentPath.slice(0, currentPath.length - 1).join('/');
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
            item = await Folder.findById(itemId);
            if (!item || item.userId !== userId) throw new Error('Folder not found or access denied');

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
            const updatedPathSegment = newPath;

            // Find and update child folders
            const childFolders = await Folder.find({ userId: userId, path: new RegExp(`^${oldPathSegment}/`) });
            const updateFolderPromises = childFolders.map(folder => {
                folder.path = folder.path.replace(oldPathSegment, updatedPathSegment);
                return folder.save();
            });

            // Find and update child files
            const childFiles = await File.find({ path: new RegExp(`^${oldPathSegment}/`) });
            const updateFilePromises = childFiles.map(file => {
                file.path = file.path.replace(oldPathSegment, updatedPathSegment);
                return file.save();
            });

            // Execute updates in parallel
            await Promise.all([...updateFolderPromises, ...updateFilePromises]);

        } else {
            // Find the file by ID
            item = await File.findById(itemId);
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

    static async moveItems(itemIds, targetFolderId) {
        try {
            // Validate the target folder
            const targetFolder = await Folder.findById(targetFolderId);
            if (!targetFolder) {
                throw new Error('Invalid target folder');
            }

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
                    { overwrite: false }
                );

                // Update item's `parent_id` and `path` in the database
                item.parent_id = targetFolderId;
                item.path = newPath;
                await item.save();

                // If the item is a folder, update the paths of all child items
                if (item instanceof Folder) {
                    const oldPathSegment = oldPath;
                    const newPathSegment = newPath;

                    // Update paths of child folders
                    const childFolders = await Folder.find({ path: new RegExp(`^${oldPathSegment}/`) });
                    for (const childFolder of childFolders) {
                        childFolder.path = childFolder.path.replace(oldPathSegment, newPathSegment);
                        await childFolder.save();
                    }

                    // Update paths of child files
                    const childFiles = await File.find({ path: new RegExp(`^${oldPathSegment}/`) });
                    for (const childFile of childFiles) {
                        childFile.path = childFile.path.replace(oldPathSegment, newPathSegment);
                        await childFile.save();
                    }
                }

                console.log(`Moved item: ${item.name}`);
            }

            // Recalculate stats for the target folder
            await this.recalculateFolderStats(targetFolderId);

            return { message: 'Items moved successfully' };
        } catch (error) {
            console.error('Error moving items:', error.message);
            throw new Error('Failed to move items');
        }
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
                console.error('Error during finalization:', err.message);
                reject(err);
            });

            archive.finalize().then(() => {
                clearTimeout(timeoutId);
                console.log('Archive finalized successfully.');
                resolve();
            }).catch((err) => {
                clearTimeout(timeoutId);
                console.error('Finalization failed:', err.message);
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

    static async recalculateFolderStats(folderId)
    {
        try {
            let folder = null;
            // Find the folder by its ID
            if (folderId) {
                folder = await Folder.findById(folderId);
            }

            if (!folder) {
                return;
            }

            // Initialize counters
            let totalSize = 0;
            let fileCount = 0;
            let folderCount = 0;

            // Read folder contents from the file system
            const folderPath = path.join(this.uploadDirectory, folder.path);
            const contents = await fs.readdir(folderPath, { withFileTypes: true });

            for (const item of contents) {
                const itemPath = `${folderPath}/${item.name}`;

                if (item.isFile()) {
                    // Get file size
                    const stats = await fs.stat(itemPath);
                    totalSize += stats.size;
                    fileCount++;
                } else if (item.isDirectory()) {
                    // Count folder and recursively calculate its stats
                    folderCount++;

                    // Find the child folder in the database and recalculate its stats
                    const childFolder = await Folder.findOne({ path: itemPath });
                    if (childFolder) {
                        const childStats = await this.recalculateFolderStats(childFolder._id);
                        totalSize += childStats.totalSize;
                        fileCount += childStats.fileCount;
                        folderCount += childStats.folderCount;
                    }
                }
            }

            // Update the current folder stats
            folder.size = totalSize;
            folder.fileCount = fileCount;
            folder.folderCount = folderCount;
            await folder.save();

            // Recalculate stats for parent folders if they exist
            await this.recalculateFolderStats(folder.parent_id);

            return { totalSize, fileCount, folderCount };
        } catch (error) {
            console.error(`Error recalculating folder stats: ${error.message}`);
            throw error;
        }
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
}

module.exports = FileService;
