// pm2 process config. Usage on the VPS:
//   npm ci && npm run build && pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "dbc-tracker",
      script: "dist/index.js",
      node_args: "--enable-source-maps",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "400M",
      // Secrets come from .env (loaded by the app via dotenv), not from here.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
