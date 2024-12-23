module.exports = {
    virusScanning: {
        enabled: process.env.ENABLE_VIRUS_SCANNING === 'true',
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
            db: process.env.REDIS_DB || 0,
            password: process.env.REDIS_PASSWORD
        }
    }
};
