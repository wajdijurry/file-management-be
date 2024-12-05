const cron = require('node-cron');
const File = require('../models/fileModel');
const Folder = require('../models/folderModel');

// Function to reset lastAccessed fields older than 1 minute
async function resetLastAccessed() {
    const timeAgo = new Date(Date.now() - 60 * 1000); // 1 minute in milliseconds

    try {
        // Update files
        await File.updateMany(
            { lastAccessed: { $lt: timeAgo } },
            { $set: { lastAccessed: null } }
        );

        // Update folders
        await Folder.updateMany(
            { lastAccessed: { $lt: timeAgo } },
            { $set: { lastAccessed: null } }
        );

        console.log('Successfully reset lastAccessed fields');
    } catch (error) {
        console.error('Error resetting lastAccessed fields:', error);
    }
}

// Schedule the task to run every minute
const scheduleAccessTimeout = () => {
    cron.schedule('* * * * *', resetLastAccessed);
    console.log('Scheduled lastAccessed reset task');
};

module.exports = scheduleAccessTimeout;