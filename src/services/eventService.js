const EventEmitter = require('events');

class FileEventEmitter extends EventEmitter {}

const fileEvents = new FileEventEmitter();

// Event types
const EVENT_TYPES = {
    FILE_UPLOADED: 'fileUploaded',
    FILE_DELETED: 'fileDeleted',
    FILE_UPDATED: 'fileUpdated'
};

module.exports = {
    fileEvents,
    EVENT_TYPES
};
