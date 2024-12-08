const cron = require('node-cron');
const File = require('../models/fileModel');
const Folder = require('../models/folderModel');

// Function to reset lastAccessed fields older than 30 minutes
async function resetLastAccessed() {
    const timeAgo = new Date(Date.now() - 60 * 1000); // 1 minute in milliseconds

    try {
        // Update files - remove expired userAccess entries
        await File.updateMany(
            { 'userAccess.lastAccessed': { $lt: timeAgo } },
            { 
                $pull: { 
                    userAccess: { 
                        lastAccessed: { $lt: timeAgo } 
                    } 
                } 
            }
        );

        // Update folders - remove expired userAccess entries
        await Folder.updateMany(
            { 'userAccess.lastAccessed': { $lt: timeAgo } },
            { 
                $pull: { 
                    userAccess: { 
                        lastAccessed: { $lt: timeAgo } 
                    } 
                } 
            }
        );

        console.log('Successfully reset expired access records');
    } catch (error) {
        console.error('Error resetting access records:', error);
    }
}

// Schedule the task to run every minute
const scheduleAccessTimeout = () => {
    cron.schedule('* * * * *', resetLastAccessed);
    console.log('Scheduled access reset task');
};

module.exports = scheduleAccessTimeout;