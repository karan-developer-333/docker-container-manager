module.exports = {
    apps: [
        {
            name: 'coderai-server',
            script: 'dist/index.js',
            instances: 1,           // Must be 1 — Docker socket is not safe to share across workers
            exec_mode: 'fork',
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'development',
                PORT: 4000,
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 4000,
            },
            // Log settings
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
            // Auto-restart on crash with exponential backoff
            autorestart: true,
            restart_delay: 2000,
            max_restarts: 10,
        },
    ],
};
