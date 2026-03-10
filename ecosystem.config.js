// PM2 process configuration
// Start with: pm2 start ecosystem.config.js
// Save & enable autostart: pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'openbrain',
      script: 'server/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/openbrain/error.log',
      out_file: '/var/log/openbrain/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
