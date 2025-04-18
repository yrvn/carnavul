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

// Helper function to validate year format
function validateYear(value) {
  const year = parseInt(value, 10);
  if (isNaN(year) || value.length !== 4 || year < 1900 || year > 2100) {
    throw new Error(
      `Invalid year format: ${value}. Please provide a 4-digit year (e.g., 2023).`
    );
  }
  return value; // Return the original string value
}

async function run() {
  const version = await getVersion();
  const program = new Command();

  program
    .name("carnavul")
    .description("Download and organize carnival videos from YouTube")
    .version(version);

  program
    .option("-c, --channel <url>", "Process a YouTube channel or playlist URL")
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
    )
    .option(
      "--year <yyyy>",
      "Manually specify the year. For --channel, forces year for all videos. For --video, used as fallback if title parsing fails.", // Updated description
      validateYear // Add validation
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
      const forcedYear = options.year || null; // Get the year option

      if (options.channel) {
        if (forcedYear) {
          logger.info(
            `Action: Processing Channel - ${options.channel} (Forcing Year: ${forcedYear}, Selecting Highest Round)`
          );
        } else {
          logger.info(
            `Action: Processing Channel - ${options.channel} (Selecting Highest Round)`
          );
        }

        const stats = await processChannel(
          options.channel,
          baseDir,
          trackingFiles,
          config,
          downloadedSet,
          logger,
          forcedYear // Pass the forced year
        );
        logger.info("Channel processing summary:", stats);
        // Updated Summary Output
        console.log("\nChannel Processing Summary (Highest Round Selection):");
        console.log("----------------------------------------------------");
        console.log(`Total Videos Found in Playlist: ${stats.total}`);
        console.log(
          `Skipped (Invalid Title/Private/Deleted - In Collection): ${stats.skipped_already_downloaded_in_collection}` // Renamed stat
        );
        console.log(
          `Ignored (No Match Year/Conjunto - Collection Pass): ${stats.ignored_no_match}`
        );
        console.log(
          `Skipped (Lower Round Priority than Chosen Video): ${stats.skipped_lower_round_than_chosen}` // Renamed stat
        );
        console.log(
          `Skipped Group (Highest Priority Video Already Downloaded): ${stats.skipped_group_high_priority_downloaded}` // New stat
        );
        console.log(`----------------------------------------------------`);
        console.log(`Highest Priority Videos Attempted: ${stats.processed}`); // Clarified this count
        console.log(` -> Downloaded/Archived: ${stats.downloaded}`);
        console.log(` -> Marked for Check Later: ${stats.checkLater}`);
        console.log(` -> Failed: ${stats.failed}`);
        console.log("----------------------------------------------------");
      } else if (options.video) {
        // Pass the year option to processSingleVideo
        logger.info(`Action: Processing Single Video - ${options.video}`);
        if (forcedYear) {
          logger.info(` -> Using --year ${forcedYear} as potential fallback.`);
        }
        const result = await processSingleVideo(
          options.video,
          baseDir,
          trackingFiles,
          config,
          downloadedSet,
          logger,
          forcedYear // Pass the forced year here
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
        // Year option remains ignored for check-later as data should be in the JSON file
        if (options.year) {
          logger.warn(
            "The --year option is ignored when processing the check later list (--check-later). Year information should be in check_later.json if needed."
          );
        }
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
          ` -> Skipped (Already Downloaded): ${stats.skipped_already_downloaded}` // This stat name is fine for check_later context
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
      // Log specific validation errors from commander/validateYear
      if (error.code && error.code.startsWith("commander.")) {
        logger.error(`Command line error: ${error.message}`);
        console.error(`\nERROR: ${error.message}`);
      } else {
        logger.error("Unhandled error during execution:", {
          message: error.message,
          stack: error.stack,
        });
        console.error("\nFATAL ERROR:", error.message);
      }
      process.exit(1); // Exit with error code
    }
  });

  await program.parseAsync(process.argv);
}

run(); // Execute the async function
