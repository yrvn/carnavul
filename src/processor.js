import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";
import { parseVideoTitle } from "./parser.js";
import { shouldDownload, downloadVideo } from "./downloader.js";
import {
  addToDownloaded,
  readTrackingJson,
  writeTrackingJson,
  addTrackingEntry,
} from "./state.js";

/**
 * Process a YouTube channel
 * @param {string} channelUrl - URL of the channel to process
 * @param {string} baseDir - Base directory for downloads
 * @param {Object} trackingFiles - Object containing paths to tracking files
 * @param {Object} config - Configuration object
 * @param {Set} downloadedSet - Set of already downloaded video IDs (from archive file)
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Processing statistics
 */
export async function processChannel(
  channelUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial skip check
  logger
) {
  logger.info(`Processing channel: ${channelUrl}`);

  const stats = {
    total: 0,
    processed: 0, // Videos attempted (not skipped initially)
    downloaded: 0, // Successful downloads reported by yt-dlp (or already in archive)
    skipped_already_downloaded: 0,
    ignored_no_match: 0,
    checkLater: 0,
    failed: 0,
  };

  try {
    // Get channel info and video list (flat)
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      extractFlat: "in_playlist", // Get basic info for videos in the playlist
      playlistReverse: true, // Process oldest first
    });

    if (!channelInfo.entries || channelInfo.entries.length === 0) {
      logger.warn(`No video entries found for channel ${channelUrl}`);
      return stats;
    }

    logger.info(`Found ${channelInfo.entries.length} videos in channel`);
    stats.total = channelInfo.entries.length;

    for (const videoStub of channelInfo.entries) {
      // Basic check: Skip if already in the initially loaded downloadedSet
      // yt-dlp --download-archive will handle the definitive check later
      if (downloadedSet.has(videoStub.id)) {
        logger.debug(
          `Video ${videoStub.id} (${videoStub.title}) found in initial downloaded set, skipping.`
        );
        stats.skipped_already_downloaded++;
        continue;
      }

      stats.processed++;
      logger.info(
        `Processing video ${stats.processed}/${stats.total}: ${videoStub.title} (ID: ${videoStub.id})`
      );

      try {
        // 1. Parse video title from the stub
        const parsedInfo = parseVideoTitle(videoStub.title, config);
        if (!parsedInfo.year || !parsedInfo.conjunto) {
          logger.info(
            `Could not identify year or conjunto for video ${videoStub.id} ('${videoStub.title}'), marking as ignored.`
          );
          await addTrackingEntry(trackingFiles.ignoredPath, {
            id: videoStub.id,
            title: videoStub.title,
            url: videoStub.url, // Use URL from stub
            reason: `Could not identify ${
              !parsedInfo.year ? "year" : "conjunto"
            } in title`,
            parsedInfo: parsedInfo, // Include what was parsed
          });
          stats.ignored_no_match++;
          continue;
        }
        logger.info(
          `Parsed title: Year=${parsedInfo.year}, Conjunto=${
            parsedInfo.conjunto.name
          }, Category=${parsedInfo.conjunto.category}${
            parsedInfo.round ? `, Round=${parsedInfo.round}` : ""
          }`
        );

        // 2. Get full video info (needed for duration check and NFO)
        logger.debug(`Fetching full metadata for ${videoStub.id}...`);
        const videoInfo = await youtubeDl(videoStub.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${videoStub.id}. Duration: ${videoInfo.duration}s`
        );

        // 3. Check if video should be downloaded based on full info
        const downloadDecision = shouldDownload(videoInfo, parsedInfo, logger);
        if (!downloadDecision.download) {
          logger.info(
            `Video ${videoStub.id} marked for check later: ${downloadDecision.reason}`
          );
          await addTrackingEntry(trackingFiles.checkLaterPath, {
            id: videoStub.id,
            title: videoInfo.title, // Use title from full info
            url: videoStub.url,
            reason: downloadDecision.reason,
            conjunto: parsedInfo.conjunto,
            year: parsedInfo.year,
            round: parsedInfo.round,
            duration: videoInfo.duration, // Add duration for context
          });
          stats.checkLater++;
          continue;
        }

        // 4. Prepare for download
        const outputDir = path.join(
          baseDir,
          parsedInfo.year,
          parsedInfo.conjunto.category
        );
        await fs.ensureDir(outputDir);

        const baseFilename = `${parsedInfo.conjunto.name} ${parsedInfo.year}${
          parsedInfo.round ? ` - ${parsedInfo.round}` : ""
        }`;

        // 5. Download video (downloader handles archive check and NFO)
        try {
          const success = await downloadVideo(
            videoStub.url,
            videoStub.id,
            outputDir,
            baseFilename,
            {
              // NFO data
              videoInfo, // Pass full info
              conjunto: parsedInfo.conjunto,
              year: parsedInfo.year,
              round: parsedInfo.round,
            },
            trackingFiles.downloadedPath, // Pass archive path
            logger
          );

          if (success) {
            // Note: yt-dlp handles adding to archive, no need for addToDownloaded here
            stats.downloaded++;
            logger.info(`Successfully processed video ${videoStub.id}`);
          } else {
            // This case should ideally not be reached if downloadVideo rejects on error
            logger.warn(
              `downloadVideo returned false for ${videoStub.id}, marking as failed.`
            );
            stats.failed++;
            await addTrackingEntry(trackingFiles.failedPath, {
              id: videoStub.id,
              title: videoInfo.title,
              url: videoStub.url,
              error: "downloadVideo returned false",
              conjunto: parsedInfo.conjunto,
              year: parsedInfo.year,
              round: parsedInfo.round,
            });
          }
        } catch (error) {
          logger.error(`Failed to download/process video ${videoStub.id}`, {
            error: error.message,
          });
          stats.failed++;
          // Add to failed log even if downloadVideo throws
          await addTrackingEntry(trackingFiles.failedPath, {
            id: videoStub.id,
            title: videoInfo.title, // Use full title if available
            url: videoStub.url,
            error: error.message,
            conjunto: parsedInfo.conjunto,
            year: parsedInfo.year,
            round: parsedInfo.round,
          });
        }
      } catch (error) {
        // Catch errors during the processing of a single video (e.g., metadata fetch failure)
        logger.error(
          `Error processing video ${videoStub.id} ('${videoStub.title}')`,
          {
            error: error.message,
          }
        );
        stats.failed++;
        await addTrackingEntry(trackingFiles.failedPath, {
          id: videoStub.id,
          title: videoStub.title, // Use stub title
          url: videoStub.url, // Use stub url
          error: `Processing error: ${error.message}`,
        });
      }
    } // End loop through videos
  } catch (error) {
    logger.error("Failed to process channel", {
      error: error.message,
      stack: error.stack,
    });
    // Rethrow or handle as appropriate for the CLI entry point
    throw error;
  }

  logger.info("Channel processing finished.", stats);
  return stats;
}

/**
 * Process a single YouTube video
 * @param {string} videoUrl - URL of the video to process
 * @param {string} baseDir - Base directory for downloads
 * @param {Object} trackingFiles - Object containing paths to tracking files
 * @param {Object} config - Configuration object
 * @param {Set} downloadedSet - Set of already downloaded video IDs
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Processing result { status: string, reason?: string, path?: string, error?: string }
 */
export async function processSingleVideo(
  videoUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial check
  logger
) {
  logger.info(`Processing single video: ${videoUrl}`);
  let videoInfo; // Declare here to use in catch block if needed

  try {
    // 1. Get full video info
    logger.debug(`Fetching full metadata for ${videoUrl}...`);
    videoInfo = await youtubeDl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
    });
    logger.debug(
      `Full metadata fetched for ${videoInfo.id}. Duration: ${videoInfo.duration}s`
    );

    // 2. Check if already downloaded (using initial set and yt-dlp archive later)
    if (downloadedSet.has(videoInfo.id)) {
      logger.info(
        `Video ${videoInfo.id} found in initial downloaded set, skipping.`
      );
      // We'll still let downloadVideo run to ensure NFO exists
      // return { status: "skipped", reason: "Already downloaded (initial check)" };
    }

    // 3. Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);
    if (!parsedInfo.year || !parsedInfo.conjunto) {
      logger.info(
        `No year or conjunto found for video ${videoInfo.id}, marking as ignored`
      );
      await addTrackingEntry(trackingFiles.ignoredPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: `Could not identify ${
          !parsedInfo.year ? "year" : "conjunto"
        } in title`,
        parsedInfo: parsedInfo,
      });
      return {
        status: "ignored",
        reason: `Could not identify ${
          !parsedInfo.year ? "year" : "conjunto"
        } in title`,
      };
    }
    logger.info(
      `Parsed title: Year=${parsedInfo.year}, Conjunto=${
        parsedInfo.conjunto.name
      }, Category=${parsedInfo.conjunto.category}${
        parsedInfo.round ? `, Round=${parsedInfo.round}` : ""
      }`
    );

    // 4. Check if video should be downloaded
    const downloadDecision = shouldDownload(videoInfo, parsedInfo, logger);
    if (!downloadDecision.download) {
      logger.info(
        `Video ${videoInfo.id} marked for check later: ${downloadDecision.reason}`
      );
      await addTrackingEntry(trackingFiles.checkLaterPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: downloadDecision.reason,
        conjunto: parsedInfo.conjunto,
        year: parsedInfo.year,
        round: parsedInfo.round,
        duration: videoInfo.duration,
      });
      return { status: "check_later", reason: downloadDecision.reason };
    }

    // 5. Prepare for download
    const outputDir = path.join(
      baseDir,
      parsedInfo.year,
      parsedInfo.conjunto.category
    );
    await fs.ensureDir(outputDir);

    const baseFilename = `${parsedInfo.conjunto.name} ${parsedInfo.year}${
      parsedInfo.round ? ` - ${parsedInfo.round}` : ""
    }`;
    const expectedNfoPath = path.join(outputDir, baseFilename + ".nfo"); // For reporting

    // 6. Download video
    try {
      await downloadVideo(
        videoUrl,
        videoInfo.id,
        outputDir,
        baseFilename,
        {
          // NFO data
          videoInfo,
          conjunto: parsedInfo.conjunto,
          year: parsedInfo.year,
          round: parsedInfo.round,
        },
        trackingFiles.downloadedPath, // Pass archive path
        logger
      );

      // No need for addToDownloaded
      logger.info(`Successfully processed single video ${videoInfo.id}`);
      return { status: "downloaded", path: expectedNfoPath }; // Report NFO path
    } catch (error) {
      logger.error(`Failed to download/process single video ${videoInfo.id}`, {
        error: error.message,
      });
      // Add to failed log
      await addTrackingEntry(trackingFiles.failedPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        error: error.message,
        conjunto: parsedInfo.conjunto,
        year: parsedInfo.year,
        round: parsedInfo.round,
      });
      return { status: "failed", error: error.message };
    }
  } catch (error) {
    logger.error("Failed to process single video", {
      videoUrl,
      error: error.message,
      stack: error.stack,
    });
    // Add to failed log if possible (if videoInfo was fetched)
    if (videoInfo && videoInfo.id) {
      await addTrackingEntry(trackingFiles.failedPath, {
        id: videoInfo.id,
        title: videoInfo.title || "Unknown Title",
        url: videoUrl,
        error: `Processing error: ${error.message}`,
      });
    } else {
      await addTrackingEntry(trackingFiles.failedPath, {
        id: "Unknown ID",
        title: "Unknown Title",
        url: videoUrl,
        error: `Processing error before fetching metadata: ${error.message}`,
      });
    }
    return { status: "failed", error: `Processing error: ${error.message}` };
  }
}

/**
 * Process videos marked for check later
 * @param {string} baseDir - Base directory for downloads
 * @param {Object} trackingFiles - Object containing paths to tracking files
 * @param {Object} config - Configuration object
 * @param {Set} downloadedSet - Set of already downloaded video IDs
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Processing statistics
 */
export async function processCheckLater(
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial check
  logger
) {
  logger.info("Processing check_later list");

  const stats = {
    total_items: 0,
    processed: 0,
    downloaded: 0,
    skipped_already_downloaded: 0,
    ignored_no_match: 0,
    failed: 0,
    incomplete_no_download_flag: 0,
  };

  let checkLaterItems = [];
  try {
    checkLaterItems = await readTrackingJson(trackingFiles.checkLaterPath);
    stats.total_items = checkLaterItems.length;
    logger.info(`Found ${stats.total_items} items in check_later list`);

    const remainingCheckLater = []; // Items that are not processed in this run

    for (const item of checkLaterItems) {
      // Ensure item has necessary fields
      if (!item || !item.id || !item.url || !item.title) {
        logger.warn("Skipping invalid item in check_later.json:", item);
        remainingCheckLater.push(item); // Keep invalid items? Or discard? Let's keep for now.
        stats.incomplete_no_download_flag++; // Use this category for invalid items too
        continue;
      }

      // Check if 'download: true' flag is set
      if (item.download !== true) {
        logger.debug(
          `Item ${item.id} does not have 'download: true' flag, skipping.`
        );
        remainingCheckLater.push(item); // Keep it in check_later unless explicitly ignored/failed
        stats.incomplete_no_download_flag++;
        continue;
      }

      stats.processed++;
      logger.info(
        `Processing check_later item ${stats.processed}/${stats.total_items}: ${item.title} (ID: ${item.id})`
      );

      // Check if already downloaded
      if (downloadedSet.has(item.id)) {
        logger.info(
          `Video ${item.id} already downloaded (initial check), skipping.`
        );
        stats.skipped_already_downloaded++;
        // Don't add back to remainingCheckLater, it's handled.
        continue;
      }

      let videoInfo;
      try {
        // Re-fetch fresh video info
        logger.debug(`Fetching full metadata for ${item.id}...`);
        videoInfo = await youtubeDl(item.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${item.id}. Duration: ${videoInfo.duration}s`
        );

        // Re-parse title to ensure we have correct info (could have been manually fixed)
        const parsedInfo = parseVideoTitle(videoInfo.title, config);
        if (!parsedInfo.year || !parsedInfo.conjunto) {
          logger.info(
            `No year or conjunto found for video ${item.id}, marking as ignored`
          );
          await addTrackingEntry(trackingFiles.ignoredPath, {
            ...item, // Keep original item info
            reason: `Could not identify ${
              !parsedInfo.year ? "year" : "conjunto"
            } in title (re-check)`,
            parsedInfo: parsedInfo,
            currentTitle: videoInfo.title, // Add current title
          });
          stats.ignored_no_match++;
          continue; // Don't add back to remainingCheckLater
        }
        logger.info(
          `Parsed title: Year=${parsedInfo.year}, Conjunto=${
            parsedInfo.conjunto.name
          }, Category=${parsedInfo.conjunto.category}${
            parsedInfo.round ? `, Round=${parsedInfo.round}` : ""
          }`
        );

        // No need to call shouldDownload again, assuming 'download: true' means intent is clear.
        // Directly proceed to download.

        const outputDir = path.join(
          baseDir,
          parsedInfo.year,
          parsedInfo.conjunto.category
        );
        await fs.ensureDir(outputDir);

        const baseFilename = `${parsedInfo.conjunto.name} ${parsedInfo.year}${
          parsedInfo.round ? ` - ${parsedInfo.round}` : ""
        }`;

        await downloadVideo(
          item.url,
          item.id,
          outputDir,
          baseFilename,
          {
            // NFO data
            videoInfo,
            conjunto: parsedInfo.conjunto,
            year: parsedInfo.year,
            round: parsedInfo.round,
          },
          trackingFiles.downloadedPath, // Pass archive path
          logger
        );

        // No need for addToDownloaded
        stats.downloaded++;
        logger.info(`Successfully processed check_later item ${item.id}`);
        // Don't add back to remainingCheckLater
      } catch (error) {
        logger.error(`Failed to process check_later item ${item.id}`, {
          error: error.message,
        });
        stats.failed++;
        // Add to failed log
        await addTrackingEntry(trackingFiles.failedPath, {
          ...item, // Keep original item info
          error: `Check_later processing error: ${error.message}`,
          currentTitle: videoInfo ? videoInfo.title : item.title, // Use fetched title if available
        });
        // Don't add back to remainingCheckLater
      }
    } // End loop

    // Update check_later.json with items that were not processed
    await writeTrackingJson(trackingFiles.checkLaterPath, remainingCheckLater);
    logger.info(
      `Updated check_later.json, ${remainingCheckLater.length} items remain.`
    );

    logger.info("Finished processing check_later list.", stats);
    return stats;
  } catch (error) {
    logger.error("Failed to read or process check_later list", {
      error: error.message,
      stack: error.stack,
    });
    // Depending on where the error occurred, checkLaterItems might be partially processed.
    // It might be safer to not overwrite check_later.json in case of a read/initial processing error.
    // However, the current structure catches errors per-item mostly.
    throw error; // Rethrow for CLI
  }
}
