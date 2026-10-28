type ShutdownDependencies = {
  closeWorker: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
};

export function createGracefulShutdown(
  dependencies: ShutdownDependencies,
  log: Pick<Console, "log" | "error"> = console,
) {
  let isShuttingDown = false;

  return async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      log.log(`Received ${signal} signal again. Already shutting down...`);
      return;
    }

    isShuttingDown = true;
    log.log(`Received ${signal} signal. Shutting down gracefully...`);

    try {
      //stop accepting new jobs
      await dependencies.closeWorker();
      log.log("BullMQ worker closed");

      //disconnect from the database
      await dependencies.disconnectDatabase();
      log.log("Prisma client disconnected");

      log.log("Graceful shutdown complete. Exiting process.");
    } catch (err) {
      log.error("Error during graceful shutdown:", err);
      process.exitCode = 1;
    }
  };
}
