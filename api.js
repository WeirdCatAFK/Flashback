import BackendAPI from './src/api/client.js';
async function main() {
  const server = new BackendAPI({
    port: 50500,  
    logFormat: 'dev'  
  });

  try {
    await server.start();
    
    process.on('SIGINT', async () => {
      await server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
  }
}

main();