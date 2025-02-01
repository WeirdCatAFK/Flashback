import api from "./src/api/api.js";
async function main() {
  const server = new api({
    port: 50500,
    logFormat: "dev",
  });

  try {
    await server.start();

    process.on("SIGINT", async () => {
      await server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

main();
