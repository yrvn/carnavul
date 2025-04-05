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
 * @param {Set} downloadedSet - Set of already downloaded video IDs
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Processing statistics
 */
export async function processChannel(
  channelUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger
) {
  logger.info(`Processing channel: ${channelUrl}`);

  const stats = {
    total: 0,
    downloaded: 0,
    skipped: 0,
    ignored: 0,
    failed: 0,
    checkLater: 0,
  };

  try {
    // Get channel info and video list
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      extractFlat: true,
    });

    logger.info(`Found ${channelInfo.entries.length} videos in channel`);
    stats.total = channelInfo.entries.length;

    for (const video of channelInfo.entries) {
      try {
        if (downloadedSet.has(video.id)) {
          logger.debug(`Video ${video.id} already downloaded, skipping`);
          stats.skipped++;
          continue;
        }

        // Parse video title
        const parsedInfo = parseVideoTitle(video.title, config);
        if (!parsedInfo.conjunto) {
          logger.info(
            `No conjunto found for video ${video.id}, marking as ignored`
          );
          await addTrackingEntry(trackingFiles.ignoredPath, {
            id: video.id,
            title: video.title,
            url: video.url,
            reason: "No conjunto match found",
          });
          stats.ignored++;
          continue;
        }

        // Get full video info
        const videoInfo = await youtubeDl(video.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });

        // Check if video should be downloaded
        const downloadDecision = shouldDownload(videoInfo);
        if (!downloadDecision.download) {
          logger.info(
            `Video ${video.id} marked for check later: ${downloadDecision.reason}`
          );
          await addTrackingEntry(trackingFiles.checkLaterPath, {
            id: video.id,
            title: video.title,
            url: video.url,
            reason: downloadDecision.reason,
            conjunto: parsedInfo.conjunto,
            year: parsedInfo.year,
          });
          stats.checkLater++;
          continue;
        }

        // Prepare for download
        const outputDir = path.join(baseDir, parsedInfo.conjunto.category);
        await fs.ensureDir(outputDir);

        const baseFilename = `${parsedInfo.conjunto.name} ${parsedInfo.year}${
          parsedInfo.round ? ` - ${parsedInfo.round}` : ""
        }`;

        // Download video
        try {
          await downloadVideo(
            video.url,
            video.id,
            outputDir,
            baseFilename,
            {
              videoInfo,
              conjunto: parsedInfo.conjunto,
              year: parsedInfo.year,
            },
            logger
          );

          await addToDownloaded(trackingFiles.downloadedPath, video.id);
          downloadedSet.add(video.id);
          stats.downloaded++;
          logger.info(`Successfully processed video ${video.id}`);
        } catch (error) {
          logger.error(`Failed to download video ${video.id}`, {
            error: error.message,
          });
          await addTrackingEntry(trackingFiles.failedPath, {
            id: video.id,
            title: video.title,
            url: video.url,
            error: error.message,
            conjunto: parsedInfo.conjunto,
            year: parsedInfo.year,
          });
          stats.failed++;
        }
      } catch (error) {
        logger.error(`Error processing video ${video.id}`, {
          error: error.message,
        });
        stats.failed++;
      }
    }
  } catch (error) {
    logger.error("Failed to process channel", { error: error.message });
    throw error;
  }

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
 * @returns {Promise<Object>} Processing result
 */
export async function processSingleVideo(
  videoUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger
) {
  logger.info(`Processing single video: ${videoUrl}`);

  try {
    // Get video info
    const videoInfo = await youtubeDl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
    });

    if (downloadedSet.has(videoInfo.id)) {
      logger.info(`Video ${videoInfo.id} already downloaded, skipping`);
      return { status: "skipped", reason: "Already downloaded" };
    }

    // Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);
    if (!parsedInfo.conjunto) {
      logger.info(
        `No conjunto found for video ${videoInfo.id}, marking as ignored`
      );
      await addTrackingEntry(trackingFiles.ignoredPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: "No conjunto match found",
      });
      return { status: "ignored", reason: "No conjunto match found" };
    }

    // Check if video should be downloaded
    const downloadDecision = shouldDownload(videoInfo);
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
      });
      return { status: "check_later", reason: downloadDecision.reason };
    }

    // Prepare for download
    const outputDir = path.join(baseDir, parsedInfo.conjunto.category);
    await fs.ensureDir(outputDir);

    const baseFilename = `${parsedInfo.conjunto.name} ${parsedInfo.year}${
      parsedInfo.round ? ` - ${parsedInfo.round}` : ""
    }`;

    // Download video
    try {
      await downloadVideo(
        videoUrl,
        videoInfo.id,
        outputDir,
        baseFilename,
        {
          videoInfo,
          conjunto: parsedInfo.conjunto,
          year: parsedInfo.year,
        },
        logger
      );

      await addToDownloaded(trackingFiles.downloadedPath, videoInfo.id);
      downloadedSet.add(videoInfo.id);
      return { status: "downloaded", path: path.join(outputDir, baseFilename) };
    } catch (error) {
      logger.error(`Failed to download video ${videoInfo.id}`, {
        error: error.message,
      });
      await addTrackingEntry(trackingFiles.failedPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        error: error.message,
        conjunto: parsedInfo.conjunto,
        year: parsedInfo.year,
      });
      return { status: "failed", error: error.message };
    }
  } catch (error) {
    logger.error("Failed to process video", { error: error.message });
    throw error;
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
  downloadedSet,
  logger
) {
  logger.info("Processing check_later list");

  const stats = {
    processedSuccessfully: [],
    failedProcessing: [],
    ignoredProcessing: [],
    incompleteItems: [],
  };

  try {
    const checkLaterItems = await readTrackingJson(
      trackingFiles.checkLaterPath
    );
    logger.info(`Found ${checkLaterItems.length} items in check_later list`);

    for (const item of checkLaterItems) {
      if (item.download === true) {
        if (downloadedSet.has(item.id)) {
          logger.info(`Video ${item.id} already downloaded, ignoring`);
          stats.ignoredProcessing.push({
            ...item,
            reason: "Already downloaded",
          });
          continue;
        }

        try {
          // Get fresh video info
          const videoInfo = await youtubeDl(item.url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
          });

          // Re-parse title to ensure we have correct info
          const parsedInfo = parseVideoTitle(videoInfo.title, config);
          if (!parsedInfo.conjunto) {
            logger.info(`No conjunto found for video ${item.id}, ignoring`);
            stats.ignoredProcessing.push({
              ...item,
              reason: "No conjunto match found",
            });
            continue;
          }

          const outputDir = path.join(baseDir, parsedInfo.conjunto.category);
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
              videoInfo,
              conjunto: parsedInfo.conjunto,
              year: parsedInfo.year,
            },
            logger
          );

          await addToDownloaded(trackingFiles.downloadedPath, item.id);
          downloadedSet.add(item.id);
          stats.processedSuccessfully.push(item);
        } catch (error) {
          logger.error(`Failed to process check_later item ${item.id}`, {
            error: error.message,
          });
          stats.failedProcessing.push({
            ...item,
            error: error.message,
          });
        }
      } else {
        stats.incompleteItems.push(item);
      }
    }

    // Update tracking files
    await Promise.all([
      writeTrackingJson(trackingFiles.failedPath, [
        ...(await readTrackingJson(trackingFiles.failedPath)),
        ...stats.failedProcessing,
      ]),
      writeTrackingJson(trackingFiles.ignoredPath, [
        ...(await readTrackingJson(trackingFiles.ignoredPath)),
        ...stats.ignoredProcessing,
      ]),
      writeTrackingJson(trackingFiles.incompletePath, [
        ...(await readTrackingJson(trackingFiles.incompletePath)),
        ...stats.incompleteItems,
      ]),
      // Clear check_later list
      writeTrackingJson(trackingFiles.checkLaterPath, []),
    ]);

    logger.info("Finished processing check_later list", {
      processed: stats.processedSuccessfully.length,
      failed: stats.failedProcessing.length,
      ignored: stats.ignoredProcessing.length,
      incomplete: stats.incompleteItems.length,
    });

    return stats;
  } catch (error) {
    logger.error("Failed to process check_later list", {
      error: error.message,
    });
    throw error;
  }
}
