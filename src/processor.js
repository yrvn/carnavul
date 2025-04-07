import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";
import { parseVideoTitle } from "./parser.js";
// Use the execSync version of downloadVideo
import { shouldDownload, downloadVideo } from "./downloader.js";
import {
  readTrackingJson,
  writeTrackingJson,
  addTrackingEntry,
} from "./state.js";

/**
 * Process a YouTube channel or playlist
 * @param {string} channelUrl - URL of the channel/playlist
 * @param {string} baseDir - Base directory for downloads
 * @param {Object} trackingFiles - Object containing paths to tracking files
 * @param {Object} config - Configuration object
 * @param {Set} downloadedSet - Set of already downloaded video IDs (from archive file)
 * @param {Object} logger - Logger instance
 * @param {string | null} forcedYear - Year provided via CLI option, or null
 * @returns {Promise<Object>} Processing statistics
 */
export async function processChannel(
  channelUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial skip check
  logger,
  forcedYear = null // Added parameter
) {
  logger.info(`Processing channel/playlist: ${channelUrl}`);
  if (forcedYear) {
    logger.info(`Using forced year for all videos: ${forcedYear}`);
  }

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
    logger.debug(`Fetching flat playlist info for: ${channelUrl}`);
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      flatPlaylist: true, // Get basic info for videos in the playlist
      playlistReverse: true, // Process oldest first
    });
    logger.debug(`Flat playlist info fetched for: ${channelUrl}`);

    if (!channelInfo.entries || channelInfo.entries.length === 0) {
      logger.warn(`No video entries found for ${channelUrl}`);
      return stats;
    }

    logger.info(
      `Found ${channelInfo.entries.length} videos in channel/playlist`
    );
    stats.total = channelInfo.entries.length;

    for (const videoStub of channelInfo.entries) {
      // Basic check: Skip if already in the initially loaded downloadedSet
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

      let videoInfo; // To store full metadata if needed
      try {
        // 1. Parse video title from the stub
        const parsedInfo = parseVideoTitle(videoStub.title, config);

        // *** LOGIC FOR FORCED YEAR ***
        let effectiveYear = parsedInfo.year;
        if (forcedYear) {
          if (parsedInfo.year && parsedInfo.year !== forcedYear) {
            logger.warn(
              `Forced year ${forcedYear} overrides year ${parsedInfo.year} found in title "${videoStub.title}".`
            );
          } else if (!parsedInfo.year) {
            logger.debug(
              `Using forced year ${forcedYear} as no year was found in title "${videoStub.title}".`
            );
          }
          effectiveYear = forcedYear; // Use the forced year
        }
        // *** END FORCED YEAR LOGIC ***

        // 2. Check if we have an effective year and a conjunto
        if (!effectiveYear || !parsedInfo.conjunto) {
          let reason = "Could not identify ";
          if (!effectiveYear && !parsedInfo.conjunto)
            reason += "year (and no forced year provided) or conjunto";
          else if (!effectiveYear)
            reason += "year (and no forced year provided)";
          else reason += "conjunto";
          reason += ` in title: "${videoStub.title}"`;

          logger.info(`${reason}, marking as ignored.`);
          await addTrackingEntry(trackingFiles.ignoredPath, {
            id: videoStub.id,
            title: videoStub.title,
            url: videoStub.url, // Use URL from stub
            reason: reason,
            parsedInfo: parsedInfo, // Include what was parsed
          });
          stats.ignored_no_match++;
          continue;
        }

        logger.info(
          `Processing with: Year=${effectiveYear}, Conjunto=${
            parsedInfo.conjunto.name
          }, Category=${parsedInfo.conjunto.category}${
            parsedInfo.round ? `, Round=${parsedInfo.round}` : ""
          }`
        );

        // 3. Get full video info (needed for duration check and NFO)
        logger.debug(`Fetching full metadata for ${videoStub.id}...`);
        videoInfo = await youtubeDl(videoStub.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${videoStub.id}. Duration: ${videoInfo.duration}s`
        );

        // 4. Check if video should be downloaded based on full info
        // Pass effectiveYear to shouldDownload if it needs it (currently it doesn't directly use it, but parsedInfo might)
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
            year: effectiveYear, // Use effective year
            round: parsedInfo.round,
            duration: videoInfo.duration, // Add duration for context
          });
          stats.checkLater++;
          continue;
        }

        // 5. Prepare for download
        const outputDir = path.join(
          baseDir,
          effectiveYear, // Use effective year
          parsedInfo.conjunto.category
        );
        await fs.ensureDir(outputDir);

        const baseFilename = `${parsedInfo.conjunto.name} ${effectiveYear}${
          // Use effective year
          parsedInfo.round ? ` - ${parsedInfo.round}` : ""
        }`;

        // 6. Download video (using execSync version)
        let success = false;
        try {
          // downloadVideo now returns boolean and throws on critical failure before NFO
          success = await downloadVideo(
            // Use await since it's async now for NFO
            videoStub.url,
            videoStub.id,
            outputDir,
            baseFilename,
            {
              // NFO data
              videoInfo, // Pass full info
              conjunto: parsedInfo.conjunto,
              year: effectiveYear, // Use effective year
              round: parsedInfo.round,
            },
            trackingFiles.downloadedPath, // Pass archive path
            logger
          );

          if (success) {
            // Note: yt-dlp handles adding to archive via --download-archive
            stats.downloaded++;
            logger.info(`Successfully processed video ${videoStub.id}`);
          } else {
            // This case happens if downloadVideo catches an execSync error and returns false
            logger.warn(
              `downloadVideo indicated failure for ${videoStub.id}, marking as failed.`
            );
            stats.failed++;
            // Add to failed log (downloadVideo already logs the error)
            await addTrackingEntry(trackingFiles.failedPath, {
              id: videoStub.id,
              title: videoInfo.title,
              url: videoStub.url,
              error: "downloadVideo returned false (likely yt-dlp exec error)",
              conjunto: parsedInfo.conjunto,
              year: effectiveYear,
              round: parsedInfo.round,
            });
          }
        } catch (error) {
          // Catch errors thrown by downloadVideo (e.g., validation errors before execSync)
          logger.error(
            `Failed to process video ${videoStub.id} due to error in downloadVideo function`,
            {
              error: error.message,
              stack: error.stack,
            }
          );
          stats.failed++;
          await addTrackingEntry(trackingFiles.failedPath, {
            id: videoStub.id,
            title: videoInfo?.title || videoStub.title, // Use fetched title if available
            url: videoStub.url,
            error: `Download function error: ${error.message}`,
            conjunto: parsedInfo.conjunto,
            year: effectiveYear,
            round: parsedInfo.round,
          });
        }
      } catch (error) {
        // Catch errors during the processing of a single video (e.g., metadata fetch failure)
        logger.error(
          `Error processing video ${videoStub.id} ('${videoStub.title}')`,
          {
            error: error.message,
            stack: error.stack, // Add stack for better debugging
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
    logger.error("Failed to process channel/playlist", {
      channelUrl: channelUrl, // Add context
      error: error.message,
      stack: error.stack,
    });
    // Rethrow or handle as appropriate for the CLI entry point
    throw error;
  }

  logger.info("Channel processing finished.", stats);
  return stats;
}

// --- processSingleVideo and processCheckLater remain unchanged ---
// They don't use the --year option.

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
        `Video ${videoInfo.id} found in initial downloaded set, skipping download but will ensure NFO exists.`
      );
      // We'll still let downloadVideo run to ensure NFO exists if needed
    }

    // 3. Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);
    if (!parsedInfo.year || !parsedInfo.conjunto) {
      let reason = "Could not identify ";
      if (!parsedInfo.year && !parsedInfo.conjunto)
        reason += "year or conjunto";
      else if (!parsedInfo.year) reason += "year";
      else reason += "conjunto";
      reason += ` in title: "${videoInfo.title}"`;

      logger.info(`${reason}, marking as ignored`);
      await addTrackingEntry(trackingFiles.ignoredPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: reason,
        parsedInfo: parsedInfo,
      });
      return {
        status: "ignored",
        reason: reason,
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
    let success = false;
    try {
      success = await downloadVideo(
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

      if (success) {
        logger.info(`Successfully processed single video ${videoInfo.id}`);
        return { status: "downloaded", path: expectedNfoPath }; // Report NFO path
      } else {
        // Should only happen if downloadVideo catches execSync error
        logger.error(
          `downloadVideo returned false for single video ${videoInfo.id}.`
        );
        await addTrackingEntry(trackingFiles.failedPath, {
          id: videoInfo.id,
          title: videoInfo.title,
          url: videoUrl,
          error: "downloadVideo returned false (likely yt-dlp exec error)",
          conjunto: parsedInfo.conjunto,
          year: parsedInfo.year,
          round: parsedInfo.round,
        });
        return {
          status: "failed",
          error: "yt-dlp execution failed (check logs)",
        };
      }
    } catch (error) {
      // Catch errors thrown by downloadVideo (e.g., validation)
      logger.error(
        `Failed to process single video ${videoInfo.id} due to error in downloadVideo function`,
        {
          error: error.message,
          stack: error.stack,
        }
      );
      await addTrackingEntry(trackingFiles.failedPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        error: `Download function error: ${error.message}`,
        conjunto: parsedInfo.conjunto,
        year: parsedInfo.year,
        round: parsedInfo.round,
      });
      return { status: "failed", error: error.message };
    }
  } catch (error) {
    // Catch errors from metadata fetching etc.
    logger.error("Failed to process single video", {
      videoUrl,
      error: error.message,
      stack: error.stack,
    });
    // Add to failed log if possible
    const errorData = {
      id: videoInfo?.id || "Unknown ID",
      title: videoInfo?.title || "Unknown Title",
      url: videoUrl,
      error: `Processing error: ${error.message}`,
    };
    await addTrackingEntry(trackingFiles.failedPath, errorData);
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
        remainingCheckLater.push(item); // Keep invalid items
        stats.incomplete_no_download_flag++;
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

      // Check if already downloaded (initial check)
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
          let reason = "Could not identify ";
          if (!parsedInfo.year && !parsedInfo.conjunto)
            reason += "year or conjunto";
          else if (!parsedInfo.year) reason += "year";
          else reason += "conjunto";
          reason += ` in title (re-check): "${videoInfo.title}"`;

          logger.info(`${reason}, marking as ignored`);
          await addTrackingEntry(trackingFiles.ignoredPath, {
            ...item, // Keep original item info
            reason: reason,
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

        let success = false;
        try {
          success = await downloadVideo(
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

          if (success) {
            stats.downloaded++;
            logger.info(`Successfully processed check_later item ${item.id}`);
            // Don't add back to remainingCheckLater
          } else {
            stats.failed++;
            logger.error(
              `downloadVideo returned false for check_later item ${item.id}.`
            );
            await addTrackingEntry(trackingFiles.failedPath, {
              ...item,
              error: `Check_later processing error: downloadVideo returned false (likely yt-dlp exec error)`,
              currentTitle: videoInfo.title,
            });
            // Don't add back to remainingCheckLater
          }
        } catch (error) {
          // Catch errors thrown by downloadVideo (e.g., validation)
          logger.error(
            `Failed to process check_later item ${item.id} due to error in downloadVideo function`,
            {
              error: error.message,
              stack: error.stack,
            }
          );
          stats.failed++;
          await addTrackingEntry(trackingFiles.failedPath, {
            ...item,
            error: `Check_later processing error: ${error.message}`,
            currentTitle: videoInfo.title,
          });
          // Don't add back to remainingCheckLater
        }
      } catch (error) {
        // Catch errors during metadata fetch for check_later item
        logger.error(
          `Failed to process check_later item ${item.id} during metadata fetch`,
          {
            error: error.message,
            stack: error.stack,
          }
        );
        stats.failed++;
        // Add to failed log
        await addTrackingEntry(trackingFiles.failedPath, {
          ...item, // Keep original item info
          error: `Check_later metadata fetch error: ${error.message}`,
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
    throw error; // Rethrow for CLI
  }
}
