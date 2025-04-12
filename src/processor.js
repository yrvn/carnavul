import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";
import { parseVideoTitle, normalizeString } from "./parser.js";
// Use the execSync version of downloadVideo
import { shouldDownload, downloadVideo } from "./downloader.js";
import {
  readTrackingJson,
  writeTrackingJson,
  addTrackingEntry,
  removeTrackingEntryById,
  getTrackingIds,
} from "./state.js";

// Helper function to determine round priority (JavaScript version)
/**
 * Determines the priority of a carnival round.
 * Higher numbers indicate higher priority (Liguilla > Segunda > Primera).
 * @param {string | null | undefined} roundName - The name of the round (e.g., "Liguilla", "Segunda Rueda").
 * @returns {number} The priority level (0-3).
 */
function getRoundPriority(roundName) {
  if (!roundName) return 0; // No round specified or null/undefined
  const normalized = normalizeString(roundName); // Use the same normalization as parser
  if (normalized.includes("liguilla")) return 3;
  if (normalized.includes("segunda") || normalized.includes("2da")) return 2;
  if (
    normalized.includes("primera") ||
    normalized.includes("1ra") ||
    normalized.includes("1era")
  )
    return 1;
  return 0; // Unknown round type treated as lowest
}

/**
 * Process a YouTube channel or playlist, keeping only the highest available round per conjunto/year.
 * @param {string} channelUrl - URL of the channel/playlist.
 * @param {string} baseDir - Base directory for downloads.
 * @param {import("./state.js").TrackingFiles} trackingFiles - Object containing paths to tracking files. (Using JSDoc import type)
 * @param {object} config - Configuration object.
 * @param {Set<string>} downloadedSet - Set of already downloaded video IDs (from archive file).
 * @param {import("winston").Logger} logger - Logger instance. (Using JSDoc import type)
 * @param {string | null} [forcedYear=null] - Year provided via CLI option, or null.
 * @returns {Promise<object>} Processing statistics.
 */
export async function processChannel(
  channelUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger,
  forcedYear = null
) {
  logger.info(
    `Processing channel/playlist: ${channelUrl} (Selecting highest *available* round per conjunto/year)`
  );
  if (forcedYear) {
    logger.info(`Using forced year for all videos: ${forcedYear}`);
  } else {
    logger.warn(
      "Processing channel without --year flag. Titles missing the year will be ignored during collection."
    );
  }

  // Stats object (plain JavaScript)
  const stats = {
    total: 0,
    skipped_already_downloaded: 0,
    ignored_no_match: 0,
    skipped_lower_round: 0, // Videos skipped *after* collection because a higher round was chosen *within the same group*
    // removed skipped_potential_lower_priority
    processed: 0, // *Chosen* videos attempted (metadata fetch + download/checkLater/fail)
    downloaded: 0,
    checkLater: 0,
    failed: 0,
  };

  let failedSet = new Set();
  try {
    failedSet = await getTrackingIds(trackingFiles.failedPath, logger);
    logger.info(
      `Loaded ${failedSet.size} IDs from failed.json for potential retry.`
    );
  } catch (error) {
    logger.error(
      "Could not load failed video IDs, proceeding without retry logic.",
      { error: error.message }
    );
  }

  // Data structure: Map<year (string), Map<conjuntoName (string), Array<PotentialVideo>>>
  const potentialVideosMap = new Map(); // Plain JS Map

  try {
    // --- First Pass: Collect Potential Videos ---
    logger.info("Starting Pass 1: Collecting video information...");
    logger.debug(`Fetching flat playlist info for: ${channelUrl}`);

    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      flatPlaylist: true,
      playlistReverse: true, // Process oldest first generally
    }); // No type assertion needed in JS

    logger.debug(`Flat playlist info fetched for: ${channelUrl}`);

    if (
      !channelInfo ||
      !channelInfo.entries ||
      channelInfo.entries.length === 0
    ) {
      logger.warn(`No video entries found for ${channelUrl}`);
      return stats;
    }

    stats.total = channelInfo.entries.length;
    logger.info(
      `Found ${stats.total} videos in channel/playlist. Collecting details...`
    );

    let collectionCount = 0;
    for (const videoStub of channelInfo.entries) {
      collectionCount++;

      // Basic check: Skip if already in the initially loaded downloadedSet
      if (downloadedSet.has(videoStub.id)) {
        logger.debug(
          `(${collectionCount}/${stats.total}) Video ${videoStub.id} (${videoStub.title}) found in downloaded set, skipping collection.`
        );
        stats.skipped_already_downloaded++;
        continue;
      }

      // Skip invalid titles early
      if (
        !videoStub.title ||
        videoStub.title.startsWith("[Private video]") ||
        videoStub.title.startsWith("[Deleted video]")
      ) {
        logger.debug(
          `(${collectionCount}/${stats.total}) Skipping special/invalid title: ${videoStub.title}`
        );
        continue;
      }

      logger.debug(
        `(${collectionCount}/${stats.total}) Collecting: ${videoStub.title} (ID: ${videoStub.id})`
      );

      // 1. Parse video title
      const parsedInfo = parseVideoTitle(videoStub.title, config); // No type needed

      // 2. Determine effective year
      let effectiveYear = parsedInfo.year; // No type needed
      if (forcedYear) {
        if (!parsedInfo.year) {
          effectiveYear = forcedYear;
          logger.debug(
            `Using forced year ${forcedYear} for title "${videoStub.title}" as parser found no year.`
          );
        } else if (parsedInfo.year !== forcedYear) {
          effectiveYear = forcedYear;
          logger.debug(
            `Overriding parsed year ${parsedInfo.year} with forced year ${forcedYear} for title "${videoStub.title}".`
          );
        }
      }

      // 3. *** CRUCIAL CHECK ***: Need both conjunto and year to proceed
      if (!parsedInfo.conjunto || !effectiveYear) {
        let reason = "Could not reliably identify ";
        const missing = []; // Plain array
        if (!parsedInfo.conjunto) missing.push("conjunto");
        if (!effectiveYear) missing.push("year (from title or --year flag)");
        reason += missing.join(" and ");
        reason += ` for title: "${videoStub.title}"`;
        logger.info(`[Collection Check Failed] ${reason}, marking as ignored.`);

        await addTrackingEntry(trackingFiles.ignoredPath, {
          id: videoStub.id,
          title: videoStub.title,
          url: videoStub.url,
          reason: `${reason} (during collection pass)`,
          parsedInfoRaw: parsedInfo,
          forcedYearProvided: forcedYear,
        });
        stats.ignored_no_match++;
        continue; // Skip collection
      }

      // 4. Store potential video info
      const conjuntoName = parsedInfo.conjunto.name;
      const roundPriority = getRoundPriority(parsedInfo.round);
      const potentialVideo = {
        // Plain JS object
        id: videoStub.id,
        url: videoStub.url,
        title: videoStub.title,
        parsedInfo: {
          year: effectiveYear,
          conjunto: parsedInfo.conjunto,
          round: parsedInfo.round,
          isAlternativeFormat: parsedInfo.isAlternativeFormat,
        },
        roundPriority: roundPriority,
      };

      // Add to map
      if (!potentialVideosMap.has(effectiveYear)) {
        potentialVideosMap.set(effectiveYear, new Map()); // Plain JS Map
      }
      const yearMap = potentialVideosMap.get(effectiveYear); // No ! needed
      if (!yearMap.has(conjuntoName)) {
        yearMap.set(conjuntoName, []); // Plain array
      }
      yearMap.get(conjuntoName).push(potentialVideo); // No ! needed

      logger.debug(
        `Collected potential video: ${conjuntoName} ${effectiveYear} (Round: ${
          parsedInfo.round || "N/A" // Use || for nullish coalescing in older JS if needed, though ?? is widely supported now
        }, Priority: ${roundPriority}) - ID: ${videoStub.id}`
      );
    } // End loop through videos

    logger.info(
      `Finished Pass 1. Collected potential videos for ${potentialVideosMap.size} year(s).`
    );

    // --- Second Pass: Select Highest Round and Process ---
    logger.info(
      "Starting Pass 2: Selecting highest *available* round and processing chosen videos..."
    );
    let groupProcessCount = 0;

    for (const [year, yearMap] of potentialVideosMap.entries()) {
      for (const [conjuntoName, videosForConjunto] of yearMap.entries()) {
        if (videosForConjunto.length === 0) continue;

        groupProcessCount++;

        // Find the video with the highest round priority *among collected*
        videosForConjunto.sort((a, b) => b.roundPriority - a.roundPriority);
        const chosenVideo = videosForConjunto[0]; // Highest priority is now first

        logger.info(
          `(${groupProcessCount}) Group: ${conjuntoName} ${year}. Highest available priority is ${
            chosenVideo.roundPriority
          } (Round: '${chosenVideo.parsedInfo.round || "N/A"}') for video: ${
            chosenVideo.title
          } (ID: ${chosenVideo.id})`
        );

        // REMOVED THE FAULTY CHECK THAT SKIPPED NON-LIGUILLA HIGHEST ROUNDS

        // Increment the actual processed count as we are processing this group's best video
        stats.processed++;
        logger.info(
          ` -> Processing chosen video (highest available): ${chosenVideo.title} (ID: ${chosenVideo.id})`
        );

        // Log skipped videos *for this group*
        for (let i = 1; i < videosForConjunto.length; i++) {
          const skippedVideo = videosForConjunto[i];
          logger.info(
            ` -> Skipping lower priority video in same group: ${skippedVideo.title} (ID: ${skippedVideo.id}, Priority: ${skippedVideo.roundPriority})`
          );
          stats.skipped_lower_round++;
          await addTrackingEntry(trackingFiles.ignoredPath, {
            id: skippedVideo.id,
            title: skippedVideo.title,
            url: skippedVideo.url,
            reason: `Skipped: Lower round priority (${skippedVideo.roundPriority}) compared to chosen video ${chosenVideo.id} (Priority ${chosenVideo.roundPriority}) for ${conjuntoName} ${year}`,
            parsedInfo: skippedVideo.parsedInfo,
          });
        }

        // Now, process the chosenVideo
        let videoInfo; // No type needed
        try {
          // Log forced year override if necessary
          const originalParsedInfoCheck = parseVideoTitle(
            chosenVideo.title,
            config
          );
          if (
            forcedYear &&
            originalParsedInfoCheck.year &&
            originalParsedInfoCheck.year !== chosenVideo.parsedInfo.year
          ) {
            logger.warn(
              `Forced year ${forcedYear} was used for chosen video ${chosenVideo.id}, overriding year ${originalParsedInfoCheck.year} potentially found in title "${chosenVideo.title}".`
            );
          }

          logger.debug(
            `Fetching full metadata for chosen video ${chosenVideo.id}...`
          );

          videoInfo = await youtubeDl(chosenVideo.url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
          }); // No type assertion needed
          logger.debug(
            `Full metadata fetched for ${chosenVideo.id}. Duration: ${
              videoInfo.duration || "N/A"
            }s`
          );

          // Check if video should be downloaded
          const downloadDecision = shouldDownload(
            videoInfo,
            chosenVideo.parsedInfo,
            logger
          );

          if (!downloadDecision.download) {
            logger.info(
              `Chosen video ${chosenVideo.id} marked for check later: ${downloadDecision.reason}`
            );
            await addTrackingEntry(trackingFiles.checkLaterPath, {
              id: chosenVideo.id,
              title: videoInfo.title,
              url: chosenVideo.url,
              reason: downloadDecision.reason,
              conjunto: chosenVideo.parsedInfo.conjunto,
              year: chosenVideo.parsedInfo.year,
              round: chosenVideo.parsedInfo.round,
              duration: videoInfo.duration,
            });
            stats.checkLater++;
            continue; // Skip download part
          }

          // Prepare for download
          // Checks for non-null already happened in Pass 1
          const outputDir = path.join(
            baseDir,
            chosenVideo.parsedInfo.year,
            chosenVideo.parsedInfo.conjunto.category
          );
          await fs.ensureDir(outputDir);
          const baseFilename = `${chosenVideo.parsedInfo.conjunto.name} ${
            chosenVideo.parsedInfo.year
          }${
            chosenVideo.parsedInfo.round
              ? ` - ${chosenVideo.parsedInfo.round}`
              : ""
          }`;

          // Download video
          let success = false;
          try {
            success = await downloadVideo(
              chosenVideo.url,
              chosenVideo.id,
              outputDir,
              baseFilename,
              {
                // NFO data
                videoInfo,
                conjunto: chosenVideo.parsedInfo.conjunto,
                year: chosenVideo.parsedInfo.year,
                round: chosenVideo.parsedInfo.round,
              },
              trackingFiles.downloadedPath,
              logger
            );

            if (success) {
              stats.downloaded++;
              logger.info(
                `Successfully processed chosen video ${chosenVideo.id}`
              );

              // Remove from failed.json if it was there
              if (failedSet.has(chosenVideo.id)) {
                await removeTrackingEntryById(
                  trackingFiles.failedPath,
                  chosenVideo.id,
                  logger
                );
                logger.info(
                  `Removed successfully processed video ${chosenVideo.id} from failed.json.`
                );
                failedSet.delete(chosenVideo.id);
              }
            } else {
              logger.warn(
                `downloadVideo indicated failure for chosen video ${chosenVideo.id}, marking as failed.`
              );
              stats.failed++;
              await addTrackingEntry(trackingFiles.failedPath, {
                id: chosenVideo.id,
                title: videoInfo ? videoInfo.title : chosenVideo.title, // Check if videoInfo exists
                url: chosenVideo.url,
                error:
                  "downloadVideo returned false (likely yt-dlp exec error)",
                year: chosenVideo.parsedInfo.year,
                conjunto: chosenVideo.parsedInfo.conjunto,
                round: chosenVideo.parsedInfo.round,
              });
            }
          } catch (downloadError) {
            logger.error(
              `Failed to process chosen video ${chosenVideo.id} during downloadVideo call`,
              { error: downloadError.message, stack: downloadError.stack }
            );
            stats.failed++;
            await addTrackingEntry(trackingFiles.failedPath, {
              id: chosenVideo.id,
              title: videoInfo ? videoInfo.title : chosenVideo.title,
              url: chosenVideo.url,
              error: `Download function error: ${downloadError.message}`,
              year: chosenVideo.parsedInfo.year,
              conjunto: chosenVideo.parsedInfo.conjunto,
              round: chosenVideo.parsedInfo.round,
            });
          }
        } catch (processingError) {
          // Catch errors during metadata fetch or shouldDownload check
          logger.error(
            `Error processing chosen video ${chosenVideo.id} ('${chosenVideo.title}') before download attempt`,
            { error: processingError.message, stack: processingError.stack }
          );
          stats.failed++;
          await addTrackingEntry(trackingFiles.failedPath, {
            id: chosenVideo.id,
            title: chosenVideo.title,
            url: chosenVideo.url,
            error: `Processing error (metadata/check): ${processingError.message}`,
            year: chosenVideo.parsedInfo.year,
            conjunto: chosenVideo.parsedInfo.conjunto,
            round: chosenVideo.parsedInfo.round,
          });
        }
      } // End loop through conjuntos for the year
    } // End loop through years

    logger.info("Finished Pass 2.");
  } catch (error) {
    // Catch errors during the initial playlist fetch or overall processing loop
    logger.error("Failed to process channel/playlist", {
      channelUrl: channelUrl,
      error: error.message,
      stack: error.stack,
    });
    throw error; // Rethrow for CLI
  }

  // Final summary adjustments
  logger.info("Channel processing finished.", stats);
  // Stats validation checks (optional but helpful)
  const accountedFor =
    stats.skipped_already_downloaded +
    stats.ignored_no_match +
    stats.skipped_lower_round +
    stats.processed;

  if (accountedFor < stats.total) {
    logger.warn(
      `Stats check: Accounted for (${accountedFor}) is less than total videos (${stats.total}). Some videos might not be categorized correctly.`
    );
  }
  const processedBreakdown = stats.downloaded + stats.checkLater + stats.failed;
  if (processedBreakdown !== stats.processed) {
    logger.warn(
      `Stats check: Processed breakdown (${processedBreakdown}) does not match total processed (${stats.processed}).`
    );
  }

  return stats;
}

/**
 * Process a single YouTube video URL.
 * @param {string} videoUrl - URL of the video.
 * @param {string} baseDir - Base directory for downloads.
 * @param {import("./state.js").TrackingFiles} trackingFiles - Object containing paths to tracking files.
 * @param {object} config - Configuration object.
 * @param {Set<string>} downloadedSet - Set of already downloaded video IDs.
 * @param {import("winston").Logger} logger - Logger instance.
 * @param {string | null} [forcedYear=null] - Year provided via CLI option, or null.
 * @returns {Promise<object>} Promise resolving to the result status object.
 */
export async function processSingleVideo(
  videoUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger,
  forcedYear = null
) {
  let failedSet = new Set();
  try {
    failedSet = await getTrackingIds(trackingFiles.failedPath, logger);
    logger.info(
      `Loaded ${failedSet.size} IDs from failed.json for single video check.`
    );
  } catch (error) {
    logger.error(
      "Could not load failed video IDs for single video processing.",
      { error: error.message }
    );
  }

  logger.info(`Processing single video: ${videoUrl}`);
  if (forcedYear) {
    logger.info(
      `--year option provided: ${forcedYear} (will be used as fallback if title has no year)`
    );
  }
  let videoInfo;

  try {
    // 1. Get full video info
    logger.debug(`Fetching full metadata for ${videoUrl}...`);
    videoInfo = await youtubeDl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
    });
    logger.debug(
      `Full metadata fetched for ${videoInfo.id}. Duration: ${
        videoInfo.duration || "N/A"
      }s`
    );

    // 2. Check if already downloaded
    const isAlreadyDownloaded = downloadedSet.has(videoInfo.id);
    if (isAlreadyDownloaded) {
      logger.info(
        `Video ${videoInfo.id} found in download archive, skipping download but will ensure NFO exists.`
      );
    }

    // 3. Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);

    // 4. Determine effective year
    let effectiveYear = parsedInfo.year;
    if (!effectiveYear && forcedYear) {
      logger.info(
        `Using provided --year ${forcedYear} as fallback since title parsing did not find a year.`
      );
      effectiveYear = forcedYear;
    } else if (
      parsedInfo.year &&
      forcedYear &&
      parsedInfo.year !== forcedYear
    ) {
      logger.warn(
        `Year ${parsedInfo.year} found in title takes precedence over provided --year ${forcedYear} for single video processing.`
      );
      // effectiveYear remains parsedInfo.year
    } else if (!parsedInfo.year && !forcedYear) {
      logger.info("No year found in title and --year option not provided.");
      // effectiveYear remains null
    }

    // 5. Check if we have an effective year and a conjunto
    if (!effectiveYear || !parsedInfo.conjunto) {
      let reason = "Could not identify ";
      const missing = [];
      if (!effectiveYear) missing.push("year (from title or --year flag)");
      if (!parsedInfo.conjunto) missing.push("conjunto");
      reason += missing.join(" and ");
      reason += ` in title: "${videoInfo.title}"`;

      logger.warn(`${reason}, marking as ignored`);
      await addTrackingEntry(trackingFiles.ignoredPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: reason,
        parsedInfoRaw: parsedInfo,
        forcedYearAttempted: forcedYear,
      });
      return {
        status: "ignored",
        reason: reason,
      };
    }

    logger.info(
      `Processing with: Year=${effectiveYear}, Conjunto=${
        parsedInfo.conjunto.name
      }, Category=${parsedInfo.conjunto.category}${
        parsedInfo.round ? `, Round=${parsedInfo.round}` : ""
      }`
    );

    // 6. Check if video should be downloaded based on criteria
    const downloadCheckInfo = {
      year: effectiveYear,
      conjunto: parsedInfo.conjunto,
      round: parsedInfo.round,
      isAlternativeFormat: parsedInfo.isAlternativeFormat,
    };
    const downloadDecision = shouldDownload(
      videoInfo,
      downloadCheckInfo,
      logger
    );

    // Only mark as check_later if not already downloaded AND download criteria not met
    if (!downloadDecision.download && !isAlreadyDownloaded) {
      logger.info(
        `Video ${videoInfo.id} marked for check later: ${downloadDecision.reason}`
      );
      await addTrackingEntry(trackingFiles.checkLaterPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        reason: downloadDecision.reason,
        conjunto: parsedInfo.conjunto,
        year: effectiveYear,
        round: parsedInfo.round,
        duration: videoInfo.duration,
      });
      return { status: "check_later", reason: downloadDecision.reason };
    }

    // 7. Prepare for download/NFO generation
    const outputDir = path.join(
      baseDir,
      effectiveYear,
      parsedInfo.conjunto.category
    );
    await fs.ensureDir(outputDir);
    const baseFilename = `${parsedInfo.conjunto.name} ${effectiveYear}${
      parsedInfo.round ? ` - ${parsedInfo.round}` : ""
    }`;
    const expectedNfoPath = path.join(outputDir, baseFilename + ".nfo");

    // 8. Download video (or just generate NFO if already downloaded)
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
          year: effectiveYear,
          round: parsedInfo.round,
        },
        trackingFiles.downloadedPath,
        logger
      );

      if (success) {
        const statusMsg = isAlreadyDownloaded
          ? "NFO ensured"
          : "downloaded successfully";
        logger.info(`Single video ${videoInfo.id} ${statusMsg}.`);
        // Remove from failed.json if it was there
        if (failedSet.has(videoInfo.id)) {
          await removeTrackingEntryById(
            trackingFiles.failedPath,
            videoInfo.id,
            logger
          );
          logger.info(
            `Removed successfully processed video ${videoInfo.id} from failed.json.`
          );
        }
        return {
          status: isAlreadyDownloaded ? "skipped" : "downloaded",
          reason: isAlreadyDownloaded
            ? "Already in download archive"
            : undefined,
          path: expectedNfoPath,
        };
      } else {
        logger.error(
          `downloadVideo returned false for single video ${videoInfo.id}.`
        );
        await addTrackingEntry(trackingFiles.failedPath, {
          id: videoInfo.id,
          title: videoInfo.title,
          url: videoUrl,
          error: "downloadVideo returned false (likely yt-dlp exec error)",
          conjunto: parsedInfo.conjunto,
          year: effectiveYear,
          round: parsedInfo.round,
        });
        return {
          status: "failed",
          error: "yt-dlp execution failed (check logs)",
        };
      }
    } catch (error) {
      logger.error(
        `Failed to process single video ${videoInfo.id} due to error in downloadVideo function`,
        { error: error.message, stack: error.stack }
      );
      await addTrackingEntry(trackingFiles.failedPath, {
        id: videoInfo.id,
        title: videoInfo.title,
        url: videoUrl,
        error: `Download function error: ${error.message}`,
        conjunto: parsedInfo.conjunto,
        year: effectiveYear,
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
    const errorData = {
      // Plain JS object
      id: videoInfo ? videoInfo.id : "Unknown ID",
      title: videoInfo ? videoInfo.title : "Unknown Title",
      url: videoUrl,
      error: `Processing error: ${error.message}`,
      forcedYearAttempted: forcedYear,
    };
    await addTrackingEntry(trackingFiles.failedPath, errorData);
    return { status: "failed", error: `Processing error: ${error.message}` };
  }
}

/**
 * Process videos marked for download in the check_later.json file.
 * @param {string} baseDir - Base directory for downloads.
 * @param {import("./state.js").TrackingFiles} trackingFiles - Object containing paths to tracking files.
 * @param {object} config - Configuration object.
 * @param {Set<string>} downloadedSet - Set of already downloaded video IDs.
 * @param {import("winston").Logger} logger - Logger instance.
 * @returns {Promise<object>} Promise resolving to processing statistics.
 */
export async function processCheckLater(
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger
) {
  let failedSet = new Set();
  try {
    failedSet = await getTrackingIds(trackingFiles.failedPath, logger);
    logger.info(
      `Loaded ${failedSet.size} IDs from failed.json for check_later processing.`
    );
  } catch (error) {
    logger.error(
      "Could not load failed video IDs for check_later processing.",
      { error: error.message }
    );
  }

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
  let remainingCheckLater = [];

  try {
    checkLaterItems = await readTrackingJson(trackingFiles.checkLaterPath); // No type assertion needed
    stats.total_items = checkLaterItems.length;
    logger.info(`Found ${stats.total_items} items in check_later list`);

    for (const item of checkLaterItems) {
      // Basic validation
      if (
        !item ||
        typeof item !== "object" ||
        !item.id ||
        !item.url ||
        !item.title
      ) {
        logger.warn(
          "Skipping invalid/incomplete item in check_later.json:",
          item
        );
        remainingCheckLater.push(item);
        stats.incomplete_no_download_flag++;
        continue;
      }

      // Check for 'download: true' flag
      if (item.download !== true) {
        logger.debug(
          `Item ${item.id} does not have 'download: true' flag, keeping in list.`
        );
        remainingCheckLater.push(item);
        stats.incomplete_no_download_flag++;
        continue;
      }

      // Item is flagged for download attempt
      stats.processed++;
      logger.info(
        `Processing check_later item ${stats.processed}/${stats.total_items}: ${item.title} (ID: ${item.id})`
      );

      // Check if already downloaded
      if (downloadedSet.has(item.id)) {
        logger.info(
          `Video ${item.id} already downloaded (found in archive), removing from check_later.`
        );
        stats.skipped_already_downloaded++;
        // Do NOT add back to remainingCheckLater
        continue;
      }

      let videoInfo;
      try {
        // Fetch fresh metadata
        logger.debug(`Fetching full metadata for ${item.id}...`);
        videoInfo = await youtubeDl(item.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${item.id}. Duration: ${
            videoInfo.duration || "N/A"
          }s`
        );

        // Re-parse current title, prioritize JSON data
        const parsedInfoFromTitle = parseVideoTitle(videoInfo.title, config);

        let effectiveYear = parsedInfoFromTitle.year;
        let effectiveConjunto = parsedInfoFromTitle.conjunto;
        let effectiveRound = parsedInfoFromTitle.round;
        let usingCheckLaterData = false;

        // Prioritize JSON data
        if (
          item.year &&
          (typeof item.year === "string" || typeof item.year === "number")
        ) {
          const itemYearStr = String(item.year);
          if (
            parsedInfoFromTitle.year &&
            parsedInfoFromTitle.year !== itemYearStr
          ) {
            logger.warn(
              `Year ${itemYearStr} from check_later.json overrides year ${parsedInfoFromTitle.year} found in current title "${videoInfo.title}". Using ${itemYearStr}.`
            );
          } else if (!parsedInfoFromTitle.year) {
            logger.info(
              `Using year ${itemYearStr} provided in check_later.json item.`
            );
          }
          effectiveYear = itemYearStr;
          usingCheckLaterData = true;
        }

        if (
          item.conjunto &&
          typeof item.conjunto === "object" &&
          item.conjunto.name &&
          item.conjunto.category
        ) {
          const itemConjunto = item.conjunto; // No type assertion needed
          if (
            parsedInfoFromTitle.conjunto &&
            parsedInfoFromTitle.conjunto.name !== itemConjunto.name
          ) {
            logger.warn(
              `Conjunto "${itemConjunto.name}" from check_later.json possibly overrides conjunto "${parsedInfoFromTitle.conjunto.name}" found in current title. Using "${itemConjunto.name}".`
            );
          } else if (!parsedInfoFromTitle.conjunto) {
            logger.info(
              `Using conjunto "${itemConjunto.name}" provided in check_later.json item.`
            );
          }
          effectiveConjunto = itemConjunto;
          usingCheckLaterData = true;
        }

        if (typeof item.round === "string") {
          const itemRound = item.round;
          if (
            parsedInfoFromTitle.round &&
            parsedInfoFromTitle.round !== itemRound
          ) {
            logger.warn(
              `Round "${itemRound}" from check_later.json overrides round "${parsedInfoFromTitle.round}" found in current title. Using "${itemRound}".`
            );
          } else if (!parsedInfoFromTitle.round) {
            logger.info(
              `Using round "${itemRound}" provided in check_later.json item.`
            );
          }
          effectiveRound = itemRound;
          usingCheckLaterData = true;
        }

        // Final check: Need year and conjunto
        if (!effectiveYear || !effectiveConjunto) {
          let reason = "Could not identify ";
          const missing = [];
          if (!effectiveYear) missing.push("year");
          if (!effectiveConjunto) missing.push("conjunto");
          reason += missing.join(" or ");
          reason += " (from current title or check_later item)";
          reason += ` for check_later item ID: ${item.id} (Current Title: "${videoInfo.title}")`;

          logger.warn(`${reason}, marking as ignored.`);
          await addTrackingEntry(trackingFiles.ignoredPath, {
            ...item,
            reason: reason,
            parsedInfoFromTitle: parsedInfoFromTitle,
            currentTitle: videoInfo.title,
            effectiveYearUsed: effectiveYear,
            effectiveConjuntoUsed: effectiveConjunto
              ? effectiveConjunto.name
              : null,
          });
          stats.ignored_no_match++;
          // Do NOT add back to remainingCheckLater
          continue;
        }

        // Log data source
        if (usingCheckLaterData) {
          logger.info(
            `Processing check_later item ${
              item.id
            } using data from JSON entry (Year: ${effectiveYear}, Conjunto: ${
              effectiveConjunto.name
            }, Round: ${effectiveRound || "N/A"})`
          );
        } else {
          logger.info(
            `Processing check_later item ${
              item.id
            } using data parsed from current title (Year=${effectiveYear}, Conjunto=${
              effectiveConjunto.name
            }, Round=${effectiveRound || "N/A"})`
          );
        }

        // Prepare for download
        const outputDir = path.join(
          baseDir,
          effectiveYear,
          effectiveConjunto.category
        );
        await fs.ensureDir(outputDir);
        const baseFilename = `${effectiveConjunto.name} ${effectiveYear}${
          effectiveRound ? ` - ${effectiveRound}` : ""
        }`;

        // Download video
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
              conjunto: effectiveConjunto,
              year: effectiveYear,
              round: effectiveRound,
            },
            trackingFiles.downloadedPath,
            logger
          );

          if (success) {
            stats.downloaded++;
            logger.info(`Successfully processed check_later item ${item.id}`);
            // Remove from failed.json if it was there
            if (failedSet.has(item.id)) {
              await removeTrackingEntryById(
                trackingFiles.failedPath,
                item.id,
                logger
              );
              logger.info(
                `Removed successfully processed video ${item.id} from failed.json (via check_later).`
              );
            }
            // Success, remove from check_later list
          } else {
            stats.failed++;
            logger.error(
              `downloadVideo returned false for check_later item ${item.id}. Adding to failed.json.`
            );
            await addTrackingEntry(trackingFiles.failedPath, {
              ...item,
              error: `Check_later processing error: downloadVideo returned false (likely yt-dlp exec error)`,
              currentTitle: videoInfo.title,
              effectiveYearUsed: effectiveYear,
              effectiveConjuntoUsed: effectiveConjunto.name,
              effectiveRoundUsed: effectiveRound,
            });
            // Failed download, remove from check_later
          }
        } catch (error) {
          stats.failed++;
          logger.error(
            `Failed to process check_later item ${item.id} during downloadVideo call`,
            { error: error.message, stack: error.stack }
          );
          await addTrackingEntry(trackingFiles.failedPath, {
            ...item,
            error: `Check_later download function error: ${error.message}`,
            currentTitle: videoInfo.title,
            effectiveYearUsed: effectiveYear,
            effectiveConjuntoUsed: effectiveConjunto.name,
            effectiveRoundUsed: effectiveRound,
          });
          // Failed download, remove from check_later
        }
      } catch (error) {
        stats.failed++;
        logger.error(
          `Failed to process check_later item ${item.id} during metadata fetch`,
          { error: error.message, stack: error.stack }
        );
        await addTrackingEntry(trackingFiles.failedPath, {
          ...item,
          error: `Check_later metadata fetch error: ${error.message}`,
        });
        // Failed metadata fetch, remove from check_later
      }
    } // End loop

    // Write back only the items that were not processed or not flagged
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
    // Attempt to save remaining state before throwing
    await writeTrackingJson(trackingFiles.checkLaterPath, remainingCheckLater);
    throw error; // Rethrow for CLI
  }
}
