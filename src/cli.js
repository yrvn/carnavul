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

const program = new Command();

program
  .name("carnavul")
  .description("Download and organize carnival videos from YouTube")
  .version("1.0.0");

program
  .option("-c, --channel <url>", "Process a YouTube channel")
  .option("-v, --video <url>", "Process a single YouTube video")
  .option("--check-later", "Process videos marked for check later")
  .option("-d, --dir <path>", "Base directory for downloads", ".")
  .option("--config <path>", "Path to configuration file", "conjuntos.json");

program.action(async (options) => {
  try {
    // Load configuration
    const config = await loadConfig(options.config);

    // Initialize tracking files
    const trackingFiles = await initTracking(options.dir);

    // Get set of downloaded videos
    const downloadedSet = await getDownloadedSet(trackingFiles.downloadedPath);

    if (options.channel) {
      // Process channel
      const stats = await processChannel(
        options.channel,
        options.dir,
        trackingFiles,
        config,
        downloadedSet,
        logger
      );

      logger.info("Channel processing completed", {
        total: stats.total,
        downloaded: stats.downloaded,
        skipped: stats.skipped,
        ignored: stats.ignored,
        failed: stats.failed,
        checkLater: stats.checkLater,
      });
    } else if (options.video) {
      // Process single video
      const result = await processSingleVideo(
        options.video,
        options.dir,
        trackingFiles,
        config,
        downloadedSet,
        logger
      );

      logger.info("Video processing completed", { result });
    } else if (options.checkLater) {
      // Process check later list
      const stats = await processCheckLater(
        options.dir,
        trackingFiles,
        config,
        downloadedSet,
        logger
      );

      logger.info("Check later processing completed", {
        processed: stats.processedSuccessfully.length,
        failed: stats.failedProcessing.length,
        ignored: stats.ignoredProcessing.length,
        incomplete: stats.incompleteItems.length,
      });
    } else {
      logger.error("No action specified. Use --help to see available options.");
      process.exit(1);
    }
  } catch (error) {
    logger.error("Unhandled error:", { error: error.message });
    process.exit(1);
  }
});

program.parse();
