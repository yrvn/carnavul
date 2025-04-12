import fs from "fs-extra";
import path from "path";
import youtubeDl from "youtube-dl-exec";
import { parseVideoTitle, normalizeString } from "./parser.js"; // Import normalizeString
// Use the execSync version of downloadVideo
import { shouldDownload, downloadVideo } from "./downloader.js";
import {
  readTrackingJson,
  writeTrackingJson,
  addTrackingEntry,
  removeTrackingEntryById, // Keep for failed handling
  getTrackingIds, // Keep for failed handling
} from "./state.js";

// Helper function to determine round priority
function getRoundPriority(roundName) {
  if (!roundName) return 0; // No round specified
  const normalized = normalizeString(roundName); // Use the same normalization as parser
  if (normalized.includes("liguilla")) return 3;
  if (normalized.includes("segunda") || normalized.includes("2da")) return 2;
  if (
    normalized.includes("primera") ||
    normalized.includes("1ra") ||
    normalized.includes("1era")
  )
    return 1; // Added 1era
  return 0; // Unknown round type treated as lowest
}

/**
 * Process a YouTube channel or playlist, keeping only the highest round per conjunto/year
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
  downloadedSet,
  logger,
  forcedYear = null
) {
  logger.info(
    `Processing channel/playlist: ${channelUrl} (Selecting highest round per conjunto/year)`
  );
  if (forcedYear) {
    logger.info(`Using forced year for all videos: ${forcedYear}`);
  } else {
    logger.warn(
      "Processing channel without --year flag. Titles missing the year will be ignored."
    );
  }

  const stats = {
    total: 0,
    skipped_already_downloaded_in_collection: 0, // Videos skipped during collection (e.g., invalid title) - Renamed for clarity
    ignored_no_match: 0, // Videos ignored during collection (no year/conjunto)
    skipped_lower_round_than_chosen: 0, // Videos skipped because a higher priority was chosen *for download*
    skipped_group_high_priority_downloaded: 0, // New: Videos skipped because the absolute highest priority was already downloaded
    processed: 0, // *Chosen* highest-priority, non-downloaded videos attempted
    downloaded: 0, // Chosen videos successfully downloaded/archived
    checkLater: 0, // Chosen videos marked for check later
    failed: 0, // Chosen videos that failed processing/download
  };

  // --- Load Failed Video IDs ---
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
  // --- End Load Failed Video IDs ---

  // Data structure: Map<year, Map<conjuntoName, Array<PotentialVideo>>>
  // PotentialVideo: { id, url, title, parsedInfo: { year, conjunto, round }, roundPriority, isDownloaded }
  const potentialVideosMap = new Map();

  try {
    // --- First Pass: Collect Potential Videos ---
    // Collect ALL potential videos, marking if they are already downloaded.
    logger.info("Starting Pass 1: Collecting info for ALL potential videos...");
    logger.debug(`Fetching flat playlist info for: ${channelUrl}`);
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      flatPlaylist: true,
      playlistReverse: true,
    });
    logger.debug(`Flat playlist info fetched for: ${channelUrl}`);

    if (!channelInfo.entries || channelInfo.entries.length === 0) {
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

      // Skip invalid titles early
      if (
        !videoStub.title ||
        videoStub.title.startsWith("[Private video]") ||
        videoStub.title.startsWith("[Deleted video]")
      ) {
        logger.debug(
          `(${collectionCount}/${stats.total}) Skipping special/invalid title: ${videoStub.title}`
        );
        stats.skipped_already_downloaded_in_collection++; // Count here as skipped pre-processing
        continue;
      }

      logger.debug(
        `(${collectionCount}/${stats.total}) Collecting: ${videoStub.title} (ID: ${videoStub.id})`
      );

      // 1. Parse video title
      const parsedInfo = parseVideoTitle(videoStub.title, config);

      // 2. Determine effective year
      let effectiveYear = parsedInfo.year;
      if (forcedYear) {
        if (!parsedInfo.year) {
          effectiveYear = forcedYear;
          logger.debug(
            `[Processor] Using forced year ${forcedYear} for title "${videoStub.title}" as parser found no year.`
          );
        } else if (parsedInfo.year !== forcedYear) {
          effectiveYear = forcedYear;
          logger.debug(
            `[Processor] Overriding parsed year ${parsedInfo.year} with forced year ${forcedYear} for title "${videoStub.title}".`
          );
        } else {
          logger.debug(
            `[Processor] Using year ${effectiveYear} (from parser or matching forced) for title "${videoStub.title}".`
          );
        }
      } else if (!parsedInfo.year) {
        effectiveYear = null;
        logger.debug(
          `[Processor] No year found by parser and no forced year provided for title "${videoStub.title}".`
        );
      }

      // 3. *** CRUCIAL CHECK *** (Identify conjunto and year)
      if (!parsedInfo.conjunto || !effectiveYear) {
        let reason = "Could not reliably identify ";
        const missing = [];
        if (!parsedInfo.conjunto) missing.push("conjunto");
        if (!effectiveYear) missing.push("year (from title or --year flag)");
        reason += missing.join(" and ");
        reason += ` for title: "${videoStub.title}"`;
        logger.info(
          `[Processor Check Failed] ${reason}, marking as ignored during collection.`
        );
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

      // 4. Store potential video info, including download status
      const conjuntoName = parsedInfo.conjunto.name;
      const roundPriority = getRoundPriority(parsedInfo.round);
      const isDownloaded = downloadedSet.has(videoStub.id); // Check download status HERE

      const potentialVideo = {
        id: videoStub.id,
        url: videoStub.url,
        title: videoStub.title,
        parsedInfo: {
          year: effectiveYear,
          conjunto: parsedInfo.conjunto,
          round: parsedInfo.round,
        },
        roundPriority: roundPriority,
        isDownloaded: isDownloaded, // Store download status
      };

      // Add to map
      if (!potentialVideosMap.has(effectiveYear)) {
        potentialVideosMap.set(effectiveYear, new Map());
      }
      const yearMap = potentialVideosMap.get(effectiveYear);
      if (!yearMap.has(conjuntoName)) {
        yearMap.set(conjuntoName, []);
      }
      yearMap.get(conjuntoName).push(potentialVideo);

      logger.debug(
        `Collected potential video: ${conjuntoName} ${effectiveYear} (Round: ${
          parsedInfo.round || "N/A"
        }, Priority: ${roundPriority}, Downloaded: ${isDownloaded}) - ID: ${
          videoStub.id
        }`
      );
    } // End loop through videos

    logger.info(
      `Finished Pass 1. Collected potential videos for ${potentialVideosMap.size} year(s).`
    );

    // --- Second Pass: Select Highest Round and Process ---
    logger.info(
      "Starting Pass 2: Selecting THE highest priority video and processing if not downloaded..."
    );
    let groupCheckCount = 0;

    for (const [year, yearMap] of potentialVideosMap.entries()) {
      for (const [conjuntoName, videosForConjunto] of yearMap.entries()) {
        groupCheckCount++;
        if (videosForConjunto.length === 0) {
          logger.debug(
            `(${groupCheckCount}) Group ${conjuntoName} ${year} is empty. Skipping.`
          );
          continue;
        }

        // 1. Find the video with the ABSOLUTE highest priority in this group
        let absoluteHighestPriorityVideo = videosForConjunto[0];
        for (let i = 1; i < videosForConjunto.length; i++) {
          if (
            videosForConjunto[i].roundPriority >
            absoluteHighestPriorityVideo.roundPriority
          ) {
            absoluteHighestPriorityVideo = videosForConjunto[i];
          }
          // Optional: Tie-breaking logic could go here if priorities are equal
        }

        logger.info(
          `(${groupCheckCount}) Checking group for ${conjuntoName} ${year}. Absolute highest priority video is: ${absoluteHighestPriorityVideo.title} (ID: ${absoluteHighestPriorityVideo.id}, Priority: ${absoluteHighestPriorityVideo.roundPriority}, Downloaded: ${absoluteHighestPriorityVideo.isDownloaded})`
        );

        // 2. Check if this absolute highest priority video is already downloaded
        if (absoluteHighestPriorityVideo.isDownloaded) {
          logger.warn(
            // Use warn level for visibility
            `(${groupCheckCount}) SKIPPING Group for ${conjuntoName} ${year}. The highest priority video (${absoluteHighestPriorityVideo.roundPriority}: ${absoluteHighestPriorityVideo.title}) is already downloaded. No lower priority videos will be processed.`
          );
          // Log other videos in the group as skipped because of this rule
          for (const video of videosForConjunto) {
            if (video.id !== absoluteHighestPriorityVideo.id) {
              logger.debug(
                ` -> Video skipped (higher priority already downloaded): ${video.title} (ID: ${video.id})`
              );
              stats.skipped_group_high_priority_downloaded++;
            }
          }
          continue; // Skip to the next conjunto/year group
        }

        // 3. If we reach here, the absolute highest priority video is NOT downloaded.
        // This is the video we should process. Let's call it chosenVideo.
        const chosenVideo = absoluteHighestPriorityVideo;
        stats.processed++; // Count this as an attempt to process
        logger.info(
          `(${groupCheckCount}) Processing chosen highest-priority, non-downloaded video for ${conjuntoName} ${year}: ${chosenVideo.title} (ID: ${chosenVideo.id}, Priority: ${chosenVideo.roundPriority})`
        );

        // 4. Log any other videos in the group as skipped lower priority
        for (const video of videosForConjunto) {
          if (video.id !== chosenVideo.id) {
            // These are genuinely lower priority OR have the same priority but weren't chosen by tie-breaking (if implemented)
            logger.info(
              ` -> Skipping lower priority video: ${video.title} (ID: ${video.id}, Priority: ${video.roundPriority}, Downloaded: ${video.isDownloaded})`
            );
            stats.skipped_lower_round_than_chosen++;
            // Optionally add to ignored.json if needed, but logging might suffice
            // await addTrackingEntry(trackingFiles.ignoredPath, { /* ... */ });
          }
        }

        // 5. Now, process the chosenVideo
        let videoInfo; // Full metadata
        try {
          // Log forced year override if necessary
          // (No change needed here)
          const originalParsedInfo = parseVideoTitle(chosenVideo.title, config);
          if (
            forcedYear &&
            originalParsedInfo.year &&
            originalParsedInfo.year !== forcedYear
          ) {
            logger.warn(
              `Forced year ${forcedYear} overrides year ${originalParsedInfo.year} found in title "${chosenVideo.title}" for chosen video ${chosenVideo.id}.`
            );
          }

          logger.debug(
            `Fetching full metadata for chosen video ${chosenVideo.id}...`
          );
          videoInfo = await youtubeDl(chosenVideo.url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
          });
          logger.debug(
            `Full metadata fetched for ${chosenVideo.id}. Duration: ${videoInfo.duration}s`
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
            continue; // Skip download part for this video
          }

          // Prepare for download
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
                // NFO data using chosen video's info
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
                title: videoInfo.title,
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
              title: videoInfo?.title || chosenVideo.title,
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
            `Error processing chosen video ${chosenVideo.id} ('${chosenVideo.title}')`,
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
  // ... (stats checks can remain) ...

  return stats;
}

// --- processSingleVideo ---
// (No changes needed here for the Liguilla priority rule, but keep failed removal logic)
export async function processSingleVideo(
  videoUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger,
  forcedYear = null
) {
  // --- Load Failed Video IDs ---
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
  // --- End Load Failed Video IDs ---

  // ... (rest of the function is unchanged from the previous version) ...
  logger.info(`Processing single video: ${videoUrl}`);
  if (forcedYear) {
    logger.info(`--year option provided: ${forcedYear}`);
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
      `Full metadata fetched for ${videoInfo.id}. Duration: ${videoInfo.duration}s`
    );

    // 2. Check if already downloaded
    if (downloadedSet.has(videoInfo.id)) {
      logger.info(
        `Video ${videoInfo.id} found in initial downloaded set, skipping download but will ensure NFO exists.`
      );
    }

    // 3. Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);

    // 4. Determine effective year (logic unchanged)
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
        `Year ${parsedInfo.year} found in title overrides provided --year ${forcedYear}. Use --channel to force override for multiple videos.`
      );
    } else if (!parsedInfo.year && !forcedYear) {
      logger.info("No year found in title and --year option not provided.");
    }

    // 5. Check if we have an effective year and a conjunto
    if (!effectiveYear || !parsedInfo.conjunto) {
      let reason = "Could not identify ";
      if (!effectiveYear && !parsedInfo.conjunto)
        reason += "year (or provided --year) or conjunto";
      else if (!effectiveYear) reason += "year (or provided --year)";
      else reason += "conjunto";
      reason += ` in title: "${videoInfo.title}"`;

      logger.info(`${reason}, marking as ignored`);
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

    // 6. Check if video should be downloaded
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
        year: effectiveYear,
        round: parsedInfo.round,
        duration: videoInfo.duration,
      });
      return { status: "check_later", reason: downloadDecision.reason };
    }

    // 7. Prepare for download
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

    // 8. Download video
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
        logger.info(`Successfully processed single video ${videoInfo.id}`);
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
        return { status: "downloaded", path: expectedNfoPath };
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
      id: videoInfo?.id || "Unknown ID",
      title: videoInfo?.title || "Unknown Title",
      url: videoUrl,
      error: `Processing error: ${error.message}`,
      forcedYearAttempted: forcedYear,
    };
    await addTrackingEntry(trackingFiles.failedPath, errorData);
    return { status: "failed", error: `Processing error: ${error.message}` };
  }
}

// --- processCheckLater ---
// (No changes needed here for the Liguilla priority rule, but keep failed removal logic)
export async function processCheckLater(
  baseDir,
  trackingFiles,
  config,
  downloadedSet,
  logger
) {
  // --- Load Failed Video IDs ---
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
  // --- End Load Failed Video IDs ---

  // ... (rest of the function is unchanged from the previous version) ...
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
    const remainingCheckLater = [];

    for (const item of checkLaterItems) {
      // ... (skip invalid, skip no 'download: true') ...
      if (!item || !item.id || !item.url || !item.title) {
        logger.warn("Skipping invalid item in check_later.json:", item);
        remainingCheckLater.push(item);
        stats.incomplete_no_download_flag++;
        continue;
      }
      if (item.download !== true) {
        logger.debug(
          `Item ${item.id} does not have 'download: true' flag, skipping.`
        );
        remainingCheckLater.push(item);
        stats.incomplete_no_download_flag++;
        continue;
      }
      stats.processed++;
      logger.info(
        `Processing check_later item ${stats.processed}/${stats.total_items}: ${item.title} (ID: ${item.id})`
      );

      // ... (check downloadedSet) ...
      if (downloadedSet.has(item.id)) {
        logger.info(
          `Video ${item.id} already downloaded (initial check), skipping.`
        );
        stats.skipped_already_downloaded++;
        continue;
      }

      let videoInfo;
      try {
        // ... (fetch videoInfo) ...
        logger.debug(`Fetching full metadata for ${item.id}...`);
        videoInfo = await youtubeDl(item.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${item.id}. Duration: ${videoInfo.duration}s`
        );

        // ... (re-parse title, determine effective info) ...
        const parsedInfo = parseVideoTitle(videoInfo.title, config);
        let effectiveYear = parsedInfo.year;
        let effectiveConjunto = parsedInfo.conjunto;
        let effectiveRound = parsedInfo.round;
        // *** Prioritize data from check_later.json item if present ***
        let usingCheckLaterData = false;
        if (item.year) {
          const itemYearStr = String(item.year);
          if (parsedInfo.year && parsedInfo.year !== itemYearStr) {
            logger.warn(
              `Year ${itemYearStr} from check_later.json overrides year ${parsedInfo.year} found in current title "${videoInfo.title}". Using ${itemYearStr}.`
            );
          } else if (!parsedInfo.year) {
            logger.info(
              `Using year ${itemYearStr} provided in check_later.json item.`
            );
          }
          effectiveYear = itemYearStr;
          usingCheckLaterData = true;
        }
        if (item.conjunto && item.conjunto.name && item.conjunto.category) {
          if (parsedInfo.conjunto?.name !== item.conjunto.name) {
            logger.warn(
              `Conjunto "${item.conjunto.name}" from check_later.json overrides conjunto "${parsedInfo.conjunto?.name}" found in current title. Using "${item.conjunto.name}".`
            );
          } else if (!parsedInfo.conjunto) {
            logger.info(
              `Using conjunto "${item.conjunto.name}" provided in check_later.json item.`
            );
          }
          effectiveConjunto = item.conjunto;
          usingCheckLaterData = true;
        }
        if (typeof item.round === "string") {
          if (parsedInfo.round && parsedInfo.round !== item.round) {
            logger.warn(
              `Round "${item.round}" from check_later.json overrides round "${parsedInfo.round}" found in current title. Using "${item.round}".`
            );
          } else if (!parsedInfo.round) {
            logger.info(
              `Using round "${item.round}" provided in check_later.json item.`
            );
          }
          effectiveRound = item.round;
          usingCheckLaterData = true;
        }
        // *** End check_later.json data logic ***

        // ... (check effectiveYear/conjunto, add to ignored if needed) ...
        if (!effectiveYear || !effectiveConjunto) {
          let reason = "Could not identify ";
          if (!effectiveYear && !effectiveConjunto)
            reason += "year or conjunto (from title or check_later item)";
          else if (!effectiveYear)
            reason += "year (from title or check_later item)";
          else reason += "conjunto (from title or check_later item)";
          reason += ` for title (re-check): "${videoInfo.title}" / check_later item ID: ${item.id}`;

          logger.info(`${reason}, marking as ignored`);
          await addTrackingEntry(trackingFiles.ignoredPath, {
            ...item,
            reason: reason,
            parsedInfoFromTitle: {
              year: parsedInfo.year,
              conjuntoName: parsedInfo.conjunto?.name,
              round: parsedInfo.round,
            },
            currentTitle: videoInfo.title,
          });
          stats.ignored_no_match++;
          continue; // Don't add back to remainingCheckLater
        }
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
            } using data parsed from title (Year=${effectiveYear}, Conjunto=${
              effectiveConjunto.name
            }, Round=${effectiveRound || "N/A"})`
          );
        }

        // ... (prepare for download) ...
        const outputDir = path.join(
          baseDir,
          effectiveYear,
          effectiveConjunto.category
        );
        await fs.ensureDir(outputDir);
        const baseFilename = `${effectiveConjunto.name} ${effectiveYear}${
          effectiveRound ? ` - ${effectiveRound}` : ""
        }`;

        let success = false;
        try {
          success = await downloadVideo(
            item.url,
            item.id,
            outputDir,
            baseFilename,
            {
              // NFO data using effective info
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
              effectiveYearUsed: effectiveYear,
              effectiveConjuntoUsed: effectiveConjunto.name,
              effectiveRoundUsed: effectiveRound,
            });
            // Don't add back to remainingCheckLater
          }
        } catch (error) {
          stats.failed++;
          logger.error(
            `Failed to process check_later item ${item.id} due to error in downloadVideo function`,
            { error: error.message, stack: error.stack }
          );
          await addTrackingEntry(trackingFiles.failedPath, {
            ...item,
            error: `Check_later processing error: ${error.message}`,
            currentTitle: videoInfo.title,
            effectiveYearUsed: effectiveYear,
            effectiveConjuntoUsed: effectiveConjunto.name,
            effectiveRoundUsed: effectiveRound,
          });
          // Don't add back to remainingCheckLater
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
        // Don't add back to remainingCheckLater
      }
    } // End loop

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
