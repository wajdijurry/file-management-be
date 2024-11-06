const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
const archiver = require('archiver');
const unzipper = require('unzipper');

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
                path: filePath, // Store relative path in DB
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
            console.log(targetPath);
            throw new Error(`The folder "${folderName}" does not exist.`);
        }

        // List all items (files and folders) in the target directory
        const items = fs.readdirSync(targetPath);

        // Find folders in the specified directory
        const folderRecords = await Folder.find({
            userId: userId,
            name: { $in: items },
            path: folderName
                ? new RegExp(`^${folderName}/[^/]+$`) // Match folders directly under the specified folderName
                : new RegExp('\s+') // Match only top-level folders when folderName is empty (root directory)
        }).exec();

        // Find files in the specified directory
        const fileRecords = await File.find({
            userId: userId,
            name: { $in: items },
            deleted: false
        }).exec();

        console.log(fileRecords);

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

        let filePath = file.path;

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
        // Find all files and folders marked for deletion
        const files = await File.find({ _id: { $in: ids }, userId: userId, deleted: false });
        const folders = await Folder.find({ _id: { $in: ids }, userId: userId, deleted: false });

        // Prepare paths for file and folder deletion from the filesystem
        const filePaths = files.map(file => path.join(this.uploadDirectory, userId, file.path));
        const folderPaths = folders.map(folder => path.join(this.uploadDirectory, userId, folder.path));

        // Helper function to recursively delete folder contents
        const deleteFolderContents = async (folderPath) => {
            // Find all nested files and folders under the current folder path
            const nestedFiles = await File.find({ userId: userId, path: new RegExp(`^${folderPath}/`), deleted: false });
            const nestedFolders = await Folder.find({ userId: userId, path: new RegExp(`^${folderPath}/`), deleted: false });

            // Collect file and folder paths for deletion from filesystem
            const nestedFilePaths = nestedFiles.map(file => path.join(this.uploadDirectory, userId, file.path));
            const nestedFolderPaths = nestedFolders.map(folder => path.join(this.uploadDirectory, userId, folder.path));

            // Delete all files in the filesystem
            await Promise.all(nestedFilePaths.map(async filePath => {
                try {
                    await fs.unlinkSync(filePath);
                    console.log(`File deleted: ${filePath}`);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        console.error(`Error deleting file: ${filePath}, Error: ${error.message}`);
                    }
                }
            }));

            // Delete folders in the filesystem
            await Promise.all(nestedFolderPaths.map(async folderPath => {
                try {
                    await fs.rmSync(folderPath, { recursive: true, force: true });
                    console.log(`Folder deleted: ${folderPath}`);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        console.error(`Error deleting folder: ${folderPath}, Error: ${error.message}`);
                    }
                }
            }));

            // Mark nested files and folders as deleted in the database
            await Promise.all([
                File.updateMany({ userId: userId, path: new RegExp(`^${folderPath}/`) }, { $set: { deleted: true } }),
                Folder.updateMany({ userId: userId, path: new RegExp(`^${folderPath}/`) }, { $set: { deleted: true } })
            ]);
        };

        // Delete top-level files in the filesystem
        await Promise.all(filePaths.map(async filePath => {
            try {
                await fs.unlinkSync(filePath, () => {});
                console.log(`File deleted: ${filePath}`);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.error(`Error deleting file: ${filePath}, Error: ${error.message}`);
                }
            }
        }));

        // Process each folder to delete its contents and itself
        await Promise.all(folders.map(async folder => {
            const folderPath = path.join(__dirname, '../../public/uploads', folder.path);
            await deleteFolderContents(folder.path); // Recursively delete contents
            try {
                await fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`Folder deleted: ${folderPath}`);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.error(`Error deleting folder: ${folderPath}, Error: ${error.message}`);
                }
            }
        }));

        // Mark top-level files and folders as deleted in the database in batch
        const result = await Promise.all([
            File.updateMany({ _id: { $in: ids }, userId: userId }, { $set: { deleted: true } }),
            Folder.updateMany({ _id: { $in: ids }, userId: userId }, { $set: { deleted: true } })
        ]);

        console.log(`Files modified: ${result[0].nModified}, Folders modified: ${result[1].nModified}`);
        return result[0].nModified + result[1].nModified;
    }

    static async viewFile(userId, fileId) {
        const filePath = await this.getFile(userId, fileId);
        const mimeType = mime.getType(filePath);
        return { filePath, mimeType };
    }

    static async createFolder(userId, name) {
        const folderPath = path.join(this.uploadDirectory, userId, name);

        // Check if folder already exists in the filesystem
        if (fs.existsSync(folderPath)) {
            throw new Error('Folder already exists');
        }

        // Create the folder in the filesystem
        fs.mkdirSync(folderPath, { recursive: true });

        // Save folder info to the database
        const folderRecord = new Folder({
            name,
            path: folderPath,
            userId: userId
        });

        return await folderRecord.save();
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
                        path: path.join(this.uploadDirectory, userId, folder, name),
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

    static async decompressFile(userId, filePath, targetFolder) {
        if (!filePath) {
            throw new Error("filePath is required");
        }

        // Determine the full path of the file and output folder
        const fullPath = path.join(this.uploadDirectory, userId, filePath);
        console.log('Full path of the zip file:', fullPath);

        if (!fs.existsSync(fullPath)) {
            throw new Error("Zip file not found");
        }

        // Define the output folder for decompression, using targetFolder as specified
        const outputFolder = path.join(path.dirname(fullPath), targetFolder);
        console.log('Output folder for decompression:', outputFolder);

        // Ensure the output folder exists before extraction
        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            fs.createReadStream(fullPath)
                .pipe(unzipper.Extract({ path: outputFolder })) // Specify the exact path for decompression
                .on('close', async () => {
                    try {
                        console.log(`Decompression complete. Files should be in ${outputFolder}`);
                        await this.registerExtractedFiles(outputFolder, path.basename(targetFolder)); // Register with targetFolder as parent
                        resolve({ message: 'File decompressed successfully' });
                    } catch (error) {
                        console.error('Error registering extracted files:', error);
                        reject(new Error('Failed to register extracted files'));
                    }
                })
                .on('error', (err) => {
                    console.error('Error during decompression:', err);
                    reject(new Error('Failed to decompress file'));
                });
        });
    }

    static async registerExtractedFiles(outputFolder, parentFolder) {
        console.log(`Registering files in folder: ${outputFolder} under parent: ${parentFolder}`);

        // First, check if the main decompressed folder (parentFolder) itself is registered in the database
        if (!(await Folder.findOne({ path: parentFolder }))) {
            console.log(`Creating main decompressed folder in DB: ${parentFolder}`);
            await Folder.create({
                name: path.basename(parentFolder),
                path: parentFolder,
                createdAt: new Date()
            });
        }

        // Now process the contents of the decompressed folder
        const items = fs.readdirSync(outputFolder);
        console.log(`Found items: ${items.join(', ')}`);

        // Preload existing folders and files within the specified parent folder
        const existingFolders = await Folder.find({ path: new RegExp(`^${parentFolder}/`) });
        const existingFiles = await File.find({ path: new RegExp(`^${parentFolder}/`), deleted: false });

        // Create sets for efficient existence checking
        const existingFolderPaths = new Set(existingFolders.map(folder => folder.path));
        const existingFilePaths = new Set(existingFiles.map(file => file.path));

        // Arrays for batch insertion of new folders and files
        const newFolders = [];
        const newFiles = [];

        for (const item of items) {
            const itemPath = path.join(outputFolder, item);
            const stats = fs.statSync(itemPath);

            // Define the correct path for each item in the database
            const dbPath = path.join(parentFolder, item);

            if (stats.isDirectory()) {
                console.log(`Detected directory: ${dbPath}`);

                if (!existingFolderPaths.has(dbPath)) {
                    console.log(`Adding folder to batch: ${dbPath}`);
                    newFolders.push({
                        name: item,
                        path: dbPath,
                        createdAt: new Date()
                    });
                }

                // Recursively register the contents of this folder
                await FileService.registerExtractedFiles(itemPath, dbPath);
            } else {
                if (!existingFilePaths.has(dbPath)) {
                    console.log(`Adding file to batch: ${dbPath}`);
                    const mimetype = mime.getType(item) || 'application/octet-stream';
                    newFiles.push({
                        name: item,
                        path: dbPath,
                        size: stats.size,
                        mimetype: mimetype,
                        createdAt: new Date(),
                        deleted: false
                    });
                }
            }
        }

        // Perform batch insertion of new folders and files
        if (newFolders.length > 0) {
            console.log(`Inserting new folders: ${newFolders.map(folder => folder.path).join(', ')}`);
            await Folder.insertMany(newFolders);
        } else {
            console.log('No new folders to insert.');
        }

        if (newFiles.length > 0) {
            console.log(`Inserting new files: ${newFiles.map(file => file.path).join(', ')}`);
            await File.insertMany(newFiles);
        } else {
            console.log('No new files to insert.');
        }
    }

    static async renameItem(itemId, newName, isFolder) {
        if (!itemId || !newName) {
            throw new Error('itemId and newName are required');
        }

        let item, oldPath, newPath;

        if (isFolder) {
            // Find the folder by ID
            item = await Folder.findById(itemId);
            if (!item) throw new Error('Folder not found');

            // Set old and new paths for renaming
            oldPath = path.join(__dirname, '../../public/uploads', item.path);
            newPath = path.join(path.dirname(oldPath), newName);

            // Rename folder in the filesystem
            await fs.rename(oldPath, newPath);

            // Update the folder's own path in the database
            const newDbPath = path.join(path.dirname(item.path), newName);
            item.name = newName;
            item.path = newDbPath;
            await item.save();

            // Find all child files and folders with paths starting with the old path
            const childFiles = await File.find({ path: new RegExp(`^${item.path}/`) });
            const childFolders = await Folder.find({ path: new RegExp(`^${item.path}/`) });

            // Update each child item to reflect the new path
            const updatePromises = [
                ...childFiles.map(file => {
                    file.path = file.path.replace(item.path, newDbPath);
                    return file.save();
                }),
                ...childFolders.map(folder => {
                    folder.path = folder.path.replace(item.path, newDbPath);
                    return folder.save();
                })
            ];

            await Promise.all(updatePromises);

        } else {
            // Find the file by ID
            item = await File.findById(itemId);
            if (!item) throw new Error('File not found');

            // Set old and new paths for renaming
            oldPath = path.join(__dirname, '../../public/uploads', item.path);
            newPath = path.join(path.dirname(oldPath), newName);

            // Rename file in the filesystem
            await fs.rename(oldPath, newPath);

            // Update the file's name and path in the database
            item.name = newName;
            item.path = path.join(path.dirname(item.path), newName);
            await item.save();
        }

        return `${isFolder ? 'Folder' : 'File'} renamed successfully`;
    }
}

module.exports = FileService;
