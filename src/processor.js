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
  removeTrackingEntryById, // <-- Import new function
  getTrackingIds, // <-- Import new function
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
    ); // Add warning if year is missing
  }

  const stats = {
    total: 0,
    skipped_already_downloaded: 0, // Videos skipped *before* collection
    ignored_no_match: 0, // Videos ignored during collection (no year/conjunto)
    skipped_lower_round: 0, // Videos skipped *after* collection because a higher round was chosen
    processed: 0, // *Chosen* videos attempted (metadata fetch + download/checkLater/fail)
    downloaded: 0, // Chosen videos successfully downloaded/archived
    checkLater: 0, // Chosen videos marked for check later
    failed: 0, // Chosen videos that failed processing/download
  };

  // --- Load Failed Video IDs ---
  let failedSet = new Set();
  try {
    failedSet = await getTrackingIds(trackingFiles.failedPath, logger); // <-- Load failed IDs
    logger.info(
      `Loaded ${failedSet.size} IDs from failed.json for potential retry.`
    );
  } catch (error) {
    logger.error(
      "Could not load failed video IDs, proceeding without retry logic.",
      { error: error.message }
    );
    // Continue without the failedSet if loading fails
  }
  // --- End Load Failed Video IDs ---

  // Data structure: Map<year, Map<conjuntoName, Array<PotentialVideo>>>
  // PotentialVideo: { id, url, title, parsedInfo: { year, conjunto, round }, roundPriority }
  const potentialVideosMap = new Map();

  try {
    // --- First Pass: Collect Potential Videos ---
    logger.info("Starting Pass 1: Collecting video information...");
    logger.debug(`Fetching flat playlist info for: ${channelUrl}`);
    const channelInfo = await youtubeDl(channelUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      flatPlaylist: true,
      playlistReverse: true, // Consider if reverse is always desired
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
      // Basic check: Skip if already in the initially loaded downloadedSet
      if (downloadedSet.has(videoStub.id)) {
        logger.debug(
          `(${collectionCount}/${stats.total}) Video ${videoStub.id} (${videoStub.title}) found in downloaded set, skipping collection.`
        );
        stats.skipped_already_downloaded++;
        continue; // <--- ONLY skip if downloaded
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

      // 3. *** CRUCIAL CHECK ***
      // Need BOTH a valid `conjunto` from parsing AND an `effectiveYear` (parsed or forced)
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
        // Add to ignored file
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

      // 4. Store potential video info (Only reached if check passes)
      const conjuntoName = parsedInfo.conjunto.name;
      const roundPriority = getRoundPriority(parsedInfo.round);

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
        }, Priority: ${roundPriority}) - ID: ${videoStub.id}`
      );
    } // End loop through videos

    logger.info(
      `Finished Pass 1. Collected potential videos for ${potentialVideosMap.size} year(s).`
    );

    // --- Second Pass: Select Highest Round and Process ---
    logger.info(
      "Starting Pass 2: Selecting highest round and processing chosen videos..."
    );
    let processedCount = 0;

    for (const [year, yearMap] of potentialVideosMap.entries()) {
      for (const [conjuntoName, videosForConjunto] of yearMap.entries()) {
        if (videosForConjunto.length === 0) continue;

        // Find the video with the highest round priority
        let chosenVideo = videosForConjunto[0];
        for (let i = 1; i < videosForConjunto.length; i++) {
          if (videosForConjunto[i].roundPriority > chosenVideo.roundPriority) {
            chosenVideo = videosForConjunto[i];
          }
        }

        processedCount++;
        stats.processed++;
        logger.info(
          `(${processedCount}) For ${conjuntoName} ${year}, chosen video: ${
            chosenVideo.title
          } (ID: ${chosenVideo.id}, Round: ${
            chosenVideo.parsedInfo.round || "N/A"
          }, Priority: ${chosenVideo.roundPriority})`
        );

        // Log skipped videos for this group
        for (const video of videosForConjunto) {
          if (video.id !== chosenVideo.id) {
            logger.info(
              ` -> Skipping lower priority video: ${video.title} (ID: ${video.id}, Priority: ${video.roundPriority})`
            );
            stats.skipped_lower_round++;
            // Add to ignored.json
            await addTrackingEntry(trackingFiles.ignoredPath, {
              id: video.id,
              title: video.title,
              url: video.url,
              reason: `Skipped: Lower round priority (${video.roundPriority}) compared to chosen video ${chosenVideo.id} (Priority: ${chosenVideo.roundPriority}) for ${conjuntoName} ${year}`,
              parsedInfo: video.parsedInfo,
            });
          }
        }

        // Now, process the chosenVideo
        let videoInfo; // Full metadata
        try {
          // Log forced year override only if it actually happened for the chosen video
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

          // Check if video should be downloaded based on full info and *chosen* parsed info
          const downloadDecision = shouldDownload(
            videoInfo,
            chosenVideo.parsedInfo, // Contains { year, conjunto, round }
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
            continue;
          }

          // Prepare for download using chosenVideo.parsedInfo
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

              // *** NEW: Remove from failed.json if it was there ***
              if (failedSet.has(chosenVideo.id)) {
                await removeTrackingEntryById(
                  trackingFiles.failedPath,
                  chosenVideo.id,
                  logger
                );
                logger.info(
                  `Removed successfully processed video ${chosenVideo.id} from failed.json.`
                );
                failedSet.delete(chosenVideo.id); // Update in-memory set too
              }
              // *** END NEW ***
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
          // Catch errors during metadata fetch or shouldDownload check for the chosen video
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
export async function processSingleVideo(
  videoUrl,
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial check
  logger,
  forcedYear = null // Accept forcedYear from CLI
) {
  logger.info(`Processing single video: ${videoUrl}`);
  if (forcedYear) {
    logger.info(`--year option provided: ${forcedYear}`);
  }

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

    // 2. Check if already downloaded
    if (downloadedSet.has(videoInfo.id)) {
      logger.info(
        `Video ${videoInfo.id} found in initial downloaded set, skipping download but will ensure NFO exists.`
      );
    }

    // 3. Parse video title
    const parsedInfo = parseVideoTitle(videoInfo.title, config);

    // *** MODIFIED YEAR LOGIC FOR SINGLE VIDEO ***
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
    // *** END MODIFIED YEAR LOGIC ***

    // 4. Check if we have an effective year and a conjunto
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

    // 5. Check if video should be downloaded
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

    // 6. Prepare for download
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

    // 7. Download video
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

        // *** NEW: Remove from failed.json if it was there ***
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
        // *** END NEW ***

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
export async function processCheckLater(
  baseDir,
  trackingFiles,
  config,
  downloadedSet, // Keep for initial check
  logger
) {
  logger.info("Processing check_later list");

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

      if (downloadedSet.has(item.id)) {
        logger.info(
          `Video ${item.id} already downloaded (initial check), skipping.`
        );
        stats.skipped_already_downloaded++;
        // Don't add back to remainingCheckLater
        continue;
      }

      let videoInfo;
      try {
        logger.debug(`Fetching full metadata for ${item.id}...`);
        videoInfo = await youtubeDl(item.url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
        });
        logger.debug(
          `Full metadata fetched for ${item.id}. Duration: ${videoInfo.duration}s`
        );

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

            // *** NEW: Remove from failed.json if it was there ***
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
            // *** END NEW ***

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
