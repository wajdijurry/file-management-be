const File = require('../models/fileModel');
const Folder = require('../models/folderModel');

class SearchService {
    /**
     * Search for files and folders by name
     * @param {string} userId - The ID of the user performing the search
     * @param {string} query - The search query
     * @param {number} limit - Maximum number of results to return
     * @returns {Promise<Array>} - Array of search results
     */
    static async searchItems(userId, query, limit = 10) {
        try {
            const searchRegex = new RegExp(query, 'i');
            const [files, folders] = await Promise.all([
            // Search in files
                File.find({
                    userId,
                    deleted: false,
                name: searchRegex
                })
                .select('name path mimetype size createdAt parent_id isPasswordProtected')
                .limit(limit)
                .lean(),

            // Search in folders
                Folder.find({
                    userId,
                    deleted: false,
                name: searchRegex
                })
                .select('name path size createdAt parent_id isPasswordProtected')
                .limit(limit)
                .lean()
            ]);

            // Format results
            const results = [
                ...folders.map(folder => ({
                    id: folder._id,
                    name: folder.name,
                    path: folder.path,
                    type: 'Folder',
                    size: folder.size,
                    createdAt: folder.createdAt,
                    isFolder: true,
                    isPasswordProtected: folder.isPasswordProtected,
                    parent_id: folder.parent_id
                })),
                ...files.map(file => ({
                    id: file._id,
                    name: file.name,
                    path: file.path,
                    type: file.mimetype,
                    size: file.size,
                    createdAt: file.createdAt,
                    isFolder: false,
                    isPasswordProtected: file.isPasswordProtected,
                    parent_id: file.parent_id
                }))
            ];

            return results;
        } catch (error) {
            console.error('Error in searchItems:', error);
            throw new Error('Failed to search items');
        }
    }
}

module.exports = SearchService;
