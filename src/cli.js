#!/usr/bin/env node

import { Command } from "commander";
import path from "path";
import logger from "./logger.js";
import { loadConfig } from "./config.js";
import { initTracking, getDownloadedSet } from "./state.js";
import {
  processChannel,
  processSingleVideo,
  processCheckLater,
} from "./processor.js";
import fs from "fs-extra";

// Helper function to read version from package.json
async function getVersion() {
  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = await fs.readJson(packageJsonPath);
    return packageJson.version || "unknown";
  } catch (error) {
    logger.warn("Could not read version from package.json", {
      error: error.message,
    });
    return "unknown";
  }
}

async function run() {
  const version = await getVersion();
  const program = new Command();

  program
    .name("carnavul")
    .description("Download and organize carnival videos from YouTube")
    .version(version);

  program
    .option("-c, --channel <url>", "Process a YouTube channel URL")
    .option("-v, --video <url>", "Process a single YouTube video URL")
    .option(
      "--check-later",
      "Process videos marked for manual review in check_later.json"
    )
    .option(
      "-d, --dir <path>",
      "Base directory for downloads and tracking files",
      "."
    )
    .option(
      "--config <path>",
      "Path to conjuntos configuration file",
      "conjuntos.json"
    )
    .option(
      "--log-level <level>",
      "Set logging level (e.g., info, debug, error)",
      "info"
    );

  program.action(async (options) => {
    // Set log level based on option
    logger.level = options.logLevel || "info";
    logger.info(`Log level set to: ${logger.level}`);
    logger.info(`Carnavul Downloader v${version} starting...`);
    logger.debug("Received options:", options);

    const baseDir = path.resolve(options.dir); // Resolve to absolute path
    logger.info(`Using base directory: ${baseDir}`);

    try {
      // Load configuration
      const config = await loadConfig(options.config);

      // Initialize tracking files
      const trackingFiles = await initTracking(baseDir);

      // Get set of downloaded videos from archive
      const downloadedSet = await getDownloadedSet(
        trackingFiles.downloadedPath
      );

      // Determine action
      if (options.channel) {
        logger.info(`Action: Processing Channel - ${options.channel}`);
        const stats = await processChannel(
          options.channel,
          baseDir,
          trackingFiles,
          config,
          downloadedSet,
          logger
        );
        logger.info("Channel processing summary:", stats);
        console.log("\nChannel Processing Summary:");
        console.log("---------------------------");
        console.log(`Total Videos Found: ${stats.total}`);
        console.log(
          `Skipped (Already Downloaded - Initial Check): ${stats.skipped_already_downloaded}`
        );
        console.log(`Processed: ${stats.processed}`);
        console.log(` -> Downloaded/Archived: ${stats.downloaded}`);
        console.log(` -> Ignored (No Match): ${stats.ignored_no_match}`);
        console.log(` -> Marked for Check Later: ${stats.checkLater}`);
        console.log(` -> Failed: ${stats.failed}`);
        console.log("---------------------------");
      } else if (options.video) {
        logger.info(`Action: Processing Single Video - ${options.video}`);
        const result = await processSingleVideo(
          options.video,
          baseDir,
          trackingFiles,
          config,
          downloadedSet,
          logger
        );
        logger.info("Video processing completed.", { result });
        console.log("\nSingle Video Processing Summary:");
        console.log("-----------------------------");
        console.log(`Status: ${result.status}`);
        if (result.reason) console.log(`Reason: ${result.reason}`);
        if (result.path) console.log(`Output NFO: ${result.path}`);
        if (result.error) console.log(`Error: ${result.error}`);
        console.log("-----------------------------");
      } else if (options.checkLater) {
        logger.info("Action: Processing Check Later list");
        const stats = await processCheckLater(
          baseDir,
          trackingFiles,
          config,
          downloadedSet,
          logger
        );
        logger.info("Check later processing completed.", { stats });
        console.log("\nCheck Later Processing Summary:");
        console.log("-----------------------------");
        console.log(`Total Items in List: ${stats.total_items}`);
        console.log(
          `Items Processed (had 'download: true'): ${stats.processed}`
        );
        console.log(` -> Downloaded/Archived: ${stats.downloaded}`);
        console.log(
          ` -> Skipped (Already Downloaded): ${stats.skipped_already_downloaded}`
        );
        console.log(` -> Ignored (No Match): ${stats.ignored_no_match}`);
        console.log(` -> Failed: ${stats.failed}`);
        console.log(
          `Items Skipped (No 'download: true' or invalid): ${stats.incomplete_no_download_flag}`
        );
        console.log("-----------------------------");
      } else {
        logger.warn(
          "No action specified. Use --channel, --video, or --check-later."
        );
        program.help(); // Show help text
      }

      logger.info("Carnavul Downloader finished.");
    } catch (error) {
      logger.error("Unhandled error during execution:", {
        message: error.message,
        stack: error.stack,
      });
      console.error("\nFATAL ERROR:", error.message);
      process.exit(1); // Exit with error code
    }
  });

  await program.parseAsync(process.argv);
}

run(); // Execute the async function
