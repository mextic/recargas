module.exports = {
  apps: [{
    name: 'recargas',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    env_development: {
      NODE_ENV: 'development'
    },
    // Logging configuration
    log_file: './logs/recargas.log',
    out_file: './logs/recargas-out.log',
    error_file: './logs/recargas-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Process management
    kill_timeout: 10000,
    listen_timeout: 10000,
    
    // Advanced features
    max_restarts: 10,
    min_uptime: '10s',
    
    // Cron restart (opcional - reiniciar diariamente a las 2 AM)
    cron_restart: '0 2 * * *'
  }]
};