const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
const archiver = require('archiver');
const extract = require('extract-zip');

class FileService {
    static uploadDirectory = path.join(__dirname, '../../public/uploads');

    static async uploadFiles(userId, files, folder = '') {
        let uploadDirectory = path.join(this.uploadDirectory, userId);
        const targetPath = folder ? path.join(uploadDirectory, folder) : uploadDirectory;

        // Ensure the target folder exists
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }

        const results = [];

        for (const file of files) {
            const filePath = path.join(targetPath, file.originalname);

            // Move the file to the target path
            fs.writeFileSync(filePath, file.buffer);

            // Save file metadata to the database
            const fileRecord = new File({
                name: file.originalname,
                path: path.join(userId, folder, file.originalname), // Store relative path in DB
                size: file.size,
                mimetype: file.mimetype,
                createdAt: new Date(),
                deleted: false,
                userId: userId
            });
            await fileRecord.save();

            results.push({ name: file.originalname, path: fileRecord.path });
        }

        return results;
    }

    // Method to calculate the size of a folder recursively
    static calculateFolderSize(folderPath) {
        let totalSize = 0;

        const items = fs.readdirSync(folderPath);
        items.forEach(item => {
            const itemPath = path.join(folderPath, item);
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                // Recursively calculate the size of subdirectories
                totalSize += FileService.calculateFolderSize(itemPath);
            } else {
                // Add the size of the file
                totalSize += stats.size;
            }
        });

        return totalSize;
    }

    static async getFiles(userId, folderName = '') {
        // Set the target path based on folderName, defaulting to the root upload directory
        let uploadDirectory = path.join(this.uploadDirectory, userId);
        const targetPath = folderName ? path.join(uploadDirectory, folderName) : uploadDirectory;

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
            throw new Error(`The folder "${folderName}" does not exist.`);
        }

        // List all items (files and folders) in the target directory
        const items = fs.readdirSync(targetPath);

        // Find folders in the specified directory
        const folderRecords = await Folder.find({
            userId: userId,
            name: { $in: items },
            deleted: false,
            // path: folderName
            //     ? new RegExp(`^${folderName}/[^/]+$`) // Match folders directly under the specified folderName
            //     : new RegExp('\s+') // Match only top-level folders when folderName is empty (root directory)
        }).exec();

        // Find files in the specified directory
        const fileRecords = await File.find({
            userId: userId,
            name: { $in: items },
            deleted: false
        }).exec();

        // Create lookup maps for quick reference
        const folderDataMap = folderRecords.reduce((acc, folder) => {
            acc[folder.name] = folder;
            return acc;
        }, {});

        const fileDataMap = fileRecords.reduce((acc, file) => {
            acc[file.name] = file;
            return acc;
        }, {});

        // Build the response data
        const filesAndFolders = await Promise.all(items.map(async item => {
            const itemPath = path.join(targetPath, item);
            const stats = fs.statSync(itemPath);
            const isFolder = stats.isDirectory();

            if (isFolder) {
                const folderRecord = folderDataMap[item];
                if (!folderRecord) return null; // Ignore if the folder is not in the database

                // Calculate folder size recursively if needed
                const folderSize = FileService.calculateFolderSize(itemPath);
                return {
                    _id: folderRecord._id,
                    name: item,
                    isFolder: true,
                    size: folderSize,
                    createdAt: stats.ctime,
                    mimetype: '',
                    fileCount: folderRecord.fileCount || 0,
                    folderCount: folderRecord.folderCount || 0,
                    path: folderRecord.path
                };
            } else {
                const fileRecord = fileDataMap[item];
                return fileRecord
                    ? {
                        _id: fileRecord._id,
                        name: fileRecord.name,
                        isFolder: false,
                        size: fileRecord.size,
                        createdAt: fileRecord.createdAt,
                        mimetype: fileRecord.mimetype,
                        path: fileRecord.path
                    }
                    : null;
            }
        }));

        // Filter out any null entries (e.g., missing files or folders in the database)
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
        return await file.save();
    }

    static async deleteMultipleFiles(userId, ids) {
        // Find files and folders to be deleted
        const files = await File.find({ _id: { $in: ids }, userId: userId, deleted: false });
        const folders = await Folder.find({ _id: { $in: ids }, userId: userId, deleted: false });

        const deletionResults = {
            filesDeleted: 0,
            foldersDeleted: 0
        };

        for (const file of files) {
            if (file.path) { // Ensure the path is defined
                const filePath = path.join(this.uploadDirectory, file.path);
                console.log(filePath);
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
                console.log(folderPath);
                if (fs.existsSync(folderPath)) {
                    try {
                        fs.rmSync(folderPath, { recursive: true, force: true });
                        console.log(`Folder deleted: ${folderPath}`);
                        deletionResults.foldersDeleted++;
                    } catch (error) {
                        console.error(`Error deleting folder: ${folderPath}, Error: ${error.message}`);
                    }
                }
            } else {
                console.warn(`Folder path is undefined for folder ID: ${folder._id}`);
            }
        }

        const deleteDbRecords = async () => {
            const fileUpdateResult = await File.updateMany(
                { _id: { $in: ids } },
                { $set: { deleted: true } }
            );
            const folderUpdateResult = await Folder.updateMany(
                { _id: { $in: ids } },
                { $set: { deleted: true } }
            );

            return {
                filesModified: fileUpdateResult.nModified,
                foldersModified: folderUpdateResult.nModified
            };
        };

        const result = await deleteDbRecords();

        console.log(`Files deleted: ${deletionResults.filesDeleted}, Folders deleted: ${deletionResults.foldersDeleted}`);
        console.log(`Database - Files modified: ${result.filesModified}, Folders modified: ${result.foldersModified}`);

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
            await Folder.deleteMany({ _id: { $in: [folderId, ...subFolderIds] } });
            await File.deleteMany({ _id: { $in: fileIds } });

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
        await fs.mkdirSync(fullPath, { recursive: true });

        // Save folder information in the database
        const newFolder = new Folder({
            userId,
            name: folderName,
            path: folderPath, // Save as relative path including userId
            createdAt: new Date()
        });

        await newFolder.save();

        return newFolder;
    }

    static async compressFiles(userId, items, folder = '', zipFileName = null) {
        const timestamp = Date.now();
        const name = zipFileName || `compressed_${timestamp}.zip`; // Use provided name or default
        const targetFolder = path.join(this.uploadDirectory, userId, folder);
        const zipFilePath = path.join(targetFolder, name);

        if (!fs.existsSync(targetFolder)) {
            throw new Error("The specified folder doesn't exist.");
        }

        let fileCount = 0;
        let folderCount = 0;

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipFilePath);
            const archive = archiver('zip', { zlib: { level: 9 } });

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
                        userId: userId
                    });

                    await compressedFile.save();

                    resolve(compressedFile);
                } catch (err) {
                    console.error('Error saving metadata:', err); // Log the specific error
                    reject(new Error('Failed to save compressed file metadata: ' + err.message));
                }
            });

            output.on('error', (err) => {
                console.error('Error during compression:', err); // Log compression error
                reject(new Error('Failed to compress files: ' + err.message));
            });

            archive.pipe(output);

            items.forEach(item => {
                const itemPath = path.join(targetFolder, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    archive.directory(itemPath, item);
                    folderCount++;
                } else {
                    archive.file(itemPath, { name: item });
                    fileCount++;
                }
            });

            archive.finalize();
        });
    }

    static async decompressFile(userId, zipFilePath, destinationFolder = '.', merge = false) {
        // Define the root directory
        const rootDir = path.resolve(`${this.uploadDirectory}/${userId}`);
        const absoluteDestination = path.resolve(rootDir, destinationFolder);
        const extractionDir = absoluteDestination;
        zipFilePath = path.join(this.uploadDirectory, zipFilePath);

        // Prevent directory traversal attack
        if (!absoluteDestination.startsWith(rootDir)) {
            throw new Error('Invalid destination folder. Directory traversal is not allowed.');
        }

        // Ensure the destination folder exists or create it
        if (!merge) {
            fs.rmSync(absoluteDestination, { recursive: true, force: true });
        }
        fs.mkdirSync(extractionDir, { recursive: true });

        // Extract the ZIP file
        await extract(zipFilePath, { dir: extractionDir });

        await this.saveExtractedContentsInDb(rootDir, extractionDir, userId, null, true);
        return absoluteDestination;
    }

    static async saveExtractedContentsInDb(rootDir, currentPath, userId, parentFolderId = null, isMainFolder = false) {
        const relativePath = path.join(userId, path.relative(rootDir, currentPath));

        // Create a folder document for the main extraction folder if needed
        if (isMainFolder) {
            let mainFolderDoc = await Folder.findOne({ path: relativePath, userId });
            if (!mainFolderDoc) {
                mainFolderDoc = new Folder({
                    name: path.basename(currentPath),
                    path: relativePath,
                    parent_id: parentFolderId,
                    userId,
                });
                await mainFolderDoc.save();
            }
            parentFolderId = mainFolderDoc._id;
        }

        // Create a folder document for the current path if it doesn't exist
        let folderDoc = await Folder.findOne({ path: relativePath, userId });
        if (!folderDoc) {
            folderDoc = new Folder({
                name: path.basename(currentPath),
                path: relativePath,
                parent_id: parentFolderId,
                userId,
            });
            await folderDoc.save();
        }
        parentFolderId = folderDoc._id;

        const items = fs.readdirSync(currentPath);

        for (const item of items) {
            const itemPath = path.join(currentPath, item);
            const stats = fs.statSync(itemPath);
            const itemRelativePath = path.join(userId, path.relative(rootDir, itemPath));

            if (stats.isDirectory()) {
                // Check if folder document already exists
                let folder = await Folder.findOne({ path: itemRelativePath, userId });
                if (!folder) {
                    // Create a folder document if it doesn't exist
                    folder = new Folder({
                        name: item,
                        path: itemRelativePath,
                        parent_id: parentFolderId,
                        userId,
                    });
                    await folder.save();
                }
                const newParentFolderId = folder._id;

                // Recursively create documents for the folder contents
                await this.saveExtractedContentsInDb(rootDir, itemPath, userId, newParentFolderId);
            } else {
                // Check if file document already exists
                let file = await File.findOne({ path: itemRelativePath, userId });
                if (!file) {
                    // Create a file document if it doesn't exist
                    const mimeType = mime.getType(itemPath) || 'application/octet-stream';
                    file = new File({
                        name: item,
                        path: itemRelativePath,
                        parent_id: parentFolderId,
                        size: stats.size,
                        mimetype: mimeType,
                        userId,
                    });
                    await file.save();
                }
            }
        }
    }

    static async renameItem(userId, itemId, newName, isFolder) {
        if (!userId || !itemId || !newName) {
            throw new Error('userId, itemId, and newName are required');
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
            const childFolders = await Folder.find({ path: new RegExp(`^${oldPathSegment}/`) });
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
            await fs.rename(oldPath, newPath);

            // Update the file's name and path in the database
            item.name = newName;
            item.path = newPath;
            await item.save();
        }

        return `${isFolder ? 'Folder' : 'File'} renamed successfully`;
    }
}

module.exports = FileService;
