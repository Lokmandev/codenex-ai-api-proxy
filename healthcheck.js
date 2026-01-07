/**
 * Docker Health Check Script
 * Used to check if the API server is running normally
 */

import http from 'http';

// Get host and port from environment variables, use defaults if not set
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.SERVER_PORT || 3000;

// Send HTTP request to health check endpoint
const options = {
  hostname: HOST,
  port: PORT,
  path: '/health',
  method: 'GET',
  timeout: 2000 // 2 second timeout
};

const req = http.request(options, (res) => {
  // If status code is 200, service is healthy
  if (res.statusCode === 200) {
    console.log('Health check passed');
    process.exit(0);
  } else {
    console.log(`Health check failed with status code: ${res.statusCode}`);
    process.exit(1);
  }
});

// Handle request errors
req.on('error', (e) => {
  console.error(`Health check failed: ${e.message}`);
  process.exit(1);
});

// Set timeout handler
req.on('timeout', () => {
  console.error('Health check timed out');
  req.destroy();
  process.exit(1);
});

// End request
req.end();