import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import dayjs from "dayjs";
import logger from "./logger.js"; // Assuming logger is correctly imported/configured elsewhere

/**
 * Check if a video should be downloaded based on its metadata
 * @param {Object} videoInfo - Full video metadata obtained from yt-dlp dump-json
 * @param {Object} parsedInfo - Result from parseVideoTitle containing year, conjunto etc.
 * @param {Object} logger - Logger instance
 * @returns {Object} Decision object with download: boolean and reason: string properties
 */
export function shouldDownload(videoInfo, parsedInfo, logger) {
  // Ensure videoInfo and parsedInfo are valid objects
  if (!videoInfo || typeof videoInfo !== "object") {
    logger.warn("[shouldDownload] Invalid videoInfo received.");
    return { download: false, reason: "Invalid video metadata received" };
  }
  if (!parsedInfo || typeof parsedInfo !== "object") {
    logger.warn("[shouldDownload] Invalid parsedInfo received.");
    return { download: false, reason: "Invalid parsed title info received" };
  }

  const { title, duration, id } = videoInfo; // Destructure safely
  const videoId = id || "Unknown ID"; // Handle missing ID

  logger.info(
    `Checking download criteria for video: ${
      title || "Unknown Title"
    } (ID: ${videoId})`
  );

  // Handle cases where duration might be missing or invalid
  const durationSeconds = parseInt(duration);
  if (isNaN(durationSeconds)) {
    logger.warn(
      `Video ${videoId} has invalid or missing duration: ${duration}, skipping duration check.`
    );
    // Decide default behavior: maybe check later? Or allow download? For now, let's mark for check later.
    return {
      download: false,
      reason: `Video has invalid duration: ${duration}`,
    };
  }
  logger.info(`Video duration: ${durationSeconds} seconds`);

  const durationMinutes = durationSeconds / 60;
  const normalizedTitle = (title || "") // Handle null/undefined title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Competition round format should always download if parsed correctly
  if (parsedInfo.isAlternativeFormat && parsedInfo.round) {
    logger.info(
      `Video ${videoId} is a competition round ('${parsedInfo.round}'), will download.`
    );
    return { download: true, reason: "Competition round format" };
  }

  // Original logic checks:
  if (durationMinutes < 30) {
    // Allow short 'fragmento' videos before 2005
    const year = parsedInfo.year ? parseInt(parsedInfo.year) : null;
    if (normalizedTitle.includes("fragmento") && year && year < 2005) {
      logger.info(
        `Video ${videoId} is a 'fragmento' before 2005, will download despite duration.`
      );
      return { download: true, reason: "Fragmento before 2005" };
    }
    logger.info(
      `Video ${videoId} duration (${durationMinutes.toFixed(
        1
      )} min) is less than 30 minutes and doesn't meet exceptions, marking for check later.`
    );
    return {
      download: false,
      reason: `Video duration (${durationMinutes.toFixed(1)} min) < 30 min`,
    };
  }

  const hasActuacionCompleta = normalizedTitle.includes("actuacion completa");
  const hasResumen = normalizedTitle.includes("resumen");

  logger.info(
    `Title conditions for ${videoId}: actuacion completa: ${hasActuacionCompleta}, resumen: ${hasResumen}`
  );

  if (hasResumen) {
    logger.info(
      `Video ${videoId} title contains 'resumen', marking for check later.`
    );
    return { download: false, reason: "Title contains 'resumen'" };
  }

  // If it's long enough (>30min) and not a 'resumen', download it.
  logger.info(
    `Video ${videoId} meets duration criteria (>30 min) and is not a 'resumen', will download.`
  );
  return { download: true, reason: "Duration > 30 min and not a resumen" };
}

/**
 * Generate NFO file content for a video
 * @param {Object} videoInfo - Video metadata
 * @param {Object} conjunto - Conjunto information { name, category }
 * @param {string} year - Performance year
 * @param {string | null} round - Performance round (optional)
 * @returns {string} NFO file content in XML format
 */
export function generateNfoContent(videoInfo, conjunto, year, round = null) {
  // Defensive checks for input data
  const safeConjunto = conjunto || { name: "Unknown", category: "Unknown" };
  const safeYear = year || "Unknown Year";
  const safeVideoInfo = videoInfo || {
    title: "Unknown Title",
    description: "",
    id: "Unknown ID",
  };

  const title = round
    ? `${safeConjunto.name} ${safeYear} - ${round}`
    : `${safeConjunto.name} ${safeYear}`;

  // Basic XML escaping for relevant fields
  const escapeXml = (unsafe) => {
    // Ensure input is treated as a string, handle null/undefined
    const str =
      unsafe === null || typeof unsafe === "undefined" ? "" : String(unsafe);
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case "<":
          return "<";
        case ">":
          return ">";
        case "&":
          return "&";
        case "'":
          return "&apos;";
        case '"':
          return '"';
        default:
          return c;
      }
    });
  };

  // Ensure videoInfo properties exist before accessing
  const originalTitle = safeVideoInfo.title;
  const description = safeVideoInfo.description;
  const videoId = safeVideoInfo.id;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${escapeXml(title)}</title>
    <originaltitle>${escapeXml(originalTitle)}</originaltitle>
    <sorttitle>${escapeXml(safeConjunto.name)} ${escapeXml(safeYear)}${
    round ? ` ${escapeXml(round)}` : ""
  }</sorttitle>
    <year>${escapeXml(safeYear)}</year>
    <genre>Carnival</genre>
    <genre>${escapeXml(safeConjunto.category)}</genre>
    ${round ? `<genre>${escapeXml(round)}</genre>` : ""}
    <plot>${escapeXml(description)}</plot>
    <source>YouTube</source>
    <id>${escapeXml(videoId)}</id>
    <uniqueid type="YouTube" default="true">${escapeXml(videoId)}</uniqueid>
    <dateadded>${dayjs().format()}</dateadded>
</movie>`;
}

/**
 * Download a video using yt-dlp
 * @param {string} videoUrl - URL of the video to download
 * @param {string} videoIdParam - Video ID passed as parameter (can be different from metadata ID initially)
 * @param {string} outputDir - Directory to save the video
 * @param {string} baseFilename - Base filename for the video and NFO files
 * @param {Object} nfoData - Data for NFO file generation { videoInfo, conjunto, year, round }
 * @param {string} downloadedArchivePath - Path to the yt-dlp download archive file
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} True if download was successful or NFO generated
 */
export function downloadVideo(
  videoUrl,
  videoIdParam, // Rename to avoid confusion with metadata ID
  outputDir,
  baseFilename,
  nfoData,
  downloadedArchivePath, // Path to .tracking/downloaded.txt
  logger
) {
  // Log the archive path being used
  logger.debug(
    `[downloadVideo] Using download archive path: '${downloadedArchivePath}' for video URL ${videoUrl} (initial ID param: ${videoIdParam})`
  );

  return new Promise((resolve, reject) => {
    // *** Validation Logic from previous correct version ***
    // 1. Check essential nfoData components first
    if (!nfoData || !nfoData.videoInfo || !nfoData.conjunto || !nfoData.year) {
      logger.error(
        `[downloadVideo] Missing essential nfoData components for video URL ${videoUrl}`,
        {
          hasNfoData: !!nfoData,
          hasVideoInfo: !!nfoData?.videoInfo,
          hasConjunto: !!nfoData?.conjunto,
          hasYear: !!nfoData?.year,
        }
      );
      return reject(
        new Error(
          `Missing essential NFO data components for video URL ${videoUrl}`
        )
      );
    }

    // 2. Now that we know videoInfo exists, check for its ID
    const videoIdFromInfo = nfoData.videoInfo.id;
    if (!videoIdFromInfo) {
      logger.error(
        `[downloadVideo] videoInfo within nfoData is missing the 'id' property for video URL ${videoUrl}`,
        { videoInfo: nfoData.videoInfo }
      );
      return reject(
        new Error(`videoInfo is missing 'id' for video URL ${videoUrl}`)
      );
    }

    // 3. Use the ID from metadata as the definitive ID for logging and processing
    let videoId = videoIdFromInfo;
    if (videoIdParam !== videoId) {
      logger.warn(
        `[downloadVideo] Initial videoId parameter ('${videoIdParam}') differs from metadata ID ('${videoId}'). Using metadata ID.`
      );
    }
    // *** END Validation Logic ***

    logger.info(
      `Starting download process for video ${videoId}: ${
        nfoData.videoInfo.title || "Unknown Title"
      }`
    );

    const outputTemplate = path.join(outputDir, baseFilename + ".%(ext)s");
    const args = [
      videoUrl,
      "--output",
      outputTemplate,
      "--write-info-json", // Write metadata to a .info.json file
      "--no-write-playlist-metafiles",
      "--no-progress",
      "--verbose", // Add verbose flag to get more detailed output from yt-dlp
      "--format",
      "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best", // Prefer mp4 up to 1080p
      "--download-archive", // Flag to use archive file
      downloadedArchivePath, // The path argument for the archive flag
      "--retries",
      "3", // Retry downloads
      "--fragment-retries",
      "3", // Retry fragments
      // "--abort-on-error", // Keep commented out to potentially get more info on non-fatal errors
    ];

    logger.debug(`Executing yt-dlp with args: ${args.join(" ")}`);

    const ytDlp = spawn("yt-dlp", args);
    let stdoutData = "";
    let stderrData = "";

    ytDlp.stdout.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        stdoutData += line + "\n";
        logger.debug(`yt-dlp stdout: ${line}`); // Keep logging stdout lines
      }
    });

    ytDlp.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        stderrData += line + "\n";
        logger.debug(`yt-dlp stderr: ${line}`); // Keep logging stderr lines
      }
    });

    ytDlp.on("error", (error) => {
      logger.error(`Failed to spawn yt-dlp process for ${videoId}`, {
        error: error.message,
        stack: error.stack, // Add stack trace
      });
      reject(error); // Reject promise if spawn fails
    });

    ytDlp.on("close", async (code) => {
      logger.debug(`yt-dlp process for ${videoId} exited with code ${code}`);

      // Check if video was already in archive (often indicated by specific stdout/stderr message)
      const alreadyDownloaded =
        stdoutData.includes("has already been recorded in the archive") ||
        stderrData.includes("has already been recorded in the archive"); // Check both streams

      if (code === 0 || alreadyDownloaded) {
        if (alreadyDownloaded) {
          logger.info(
            `Video ${videoId} already in download archive, skipping download but ensuring NFO exists.`
          );
        } else {
          // code === 0 and not alreadyDownloaded
          logger.info(
            `yt-dlp downloaded video ${videoId} successfully (exit code 0). Archive *should* be updated by yt-dlp.`
          );
          // Optional Sanity check (uncomment if needed for deep debugging of archive write issues)
          /*
             try {
               // Check write access explicitly before reading, more informative if it fails here
               await fs.access(downloadedArchivePath, fs.constants.W_OK);
               logger.debug(`[SANITY CHECK] Write access confirmed for archive file: '${downloadedArchivePath}'`);

               const archiveContent = await fs.readFile(downloadedArchivePath, 'utf8');
               if (!archiveContent.includes(videoId)) {
                  // Use includes for simplicity, assumes ID format is consistent enough
                  logger.warn(`[SANITY CHECK FAILED] yt-dlp exited 0 for ${videoId}, but ID not found in archive file '${downloadedArchivePath}' immediately after.`);
               } else {
                  logger.debug(`[SANITY CHECK PASSED] yt-dlp exited 0 for ${videoId}, ID found in archive file '${downloadedArchivePath}'.`);
               }
             } catch (checkErr) {
                logger.error(`[SANITY CHECK ERROR] Failed check on archive file '${downloadedArchivePath}' after yt-dlp exit 0 for ${videoId}`, { message: checkErr.message, code: checkErr.code });
             }
             */
        }

        try {
          // Generate and write NFO file
          const nfoPath = path.join(outputDir, baseFilename + ".nfo");
          if (!(await fs.pathExists(nfoPath))) {
            // Ensure NFO data is still valid before generating (paranoid check)
            // Note: We already validated nfoData components at the start of the promise executor
            const nfoContent = generateNfoContent(
              nfoData.videoInfo,
              nfoData.conjunto,
              nfoData.year,
              nfoData.round // Pass round info
            );
            await fs.writeFile(nfoPath, nfoContent);
            logger.info(`Created NFO file for ${videoId} at ${nfoPath}`);
          } else {
            logger.debug(
              `NFO file already exists for ${videoId} at ${nfoPath}`
            );
          }
          resolve(true); // Success (downloaded or already present or NFO created/exists)
        } catch (error) {
          logger.error(
            `Failed to write NFO file for ${videoId} after successful download/archive check`,
            {
              nfoPath: nfoPath, // Log the path it tried to write to
              error: error.message,
              stack: error.stack,
            }
          );
          // Resolve true because download/archive check part was okay, NFO failure is secondary
          resolve(true);
        }
      } else {
        // yt-dlp failed for a reason other than being already archived
        logger.error(
          `yt-dlp process for ${videoId} failed with exit code ${code}.`
        );
        // Log the stderr and stdout streams explicitly for easier debugging
        logger.error("yt-dlp STDERR:", {
          stderr: stderrData || "No stderr output",
        });
        logger.error("yt-dlp STDOUT:", {
          stdout: stdoutData || "No stdout output",
        });
        // Reject the promise to signal failure up the chain
        reject(
          new Error(`yt-dlp exited with code ${code}. Check logs for details.`)
        );
      }
    });
  });
}
