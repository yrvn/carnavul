import { execSync } from "child_process"; // Import execSync
import fs from "fs-extra";
import path from "path";
import dayjs from "dayjs";
import logger from "./logger.js";

// ... shouldDownload function (no changes needed) ...
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
    return {
      download: false,
      reason: `Video has invalid duration: ${duration}`,
    };
  }
  logger.info(`Video duration: ${durationSeconds} seconds`);

  const durationMinutes = durationSeconds / 60;
  const normalizedTitle = (title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (parsedInfo.isAlternativeFormat && parsedInfo.round) {
    logger.info(
      `Video ${videoId} is a competition round ('${parsedInfo.round}'), will download.`
    );
    return { download: true, reason: "Competition round format" };
  }

  if (durationMinutes < 30) {
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
      )} min) < 30 min, marking for check later.`
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

  logger.info(
    `Video ${videoId} meets duration criteria (>30 min) and is not a 'resumen', will download.`
  );
  return { download: true, reason: "Duration > 30 min and not a resumen" };
}

// ... generateNfoContent function (no changes needed) ...
export function generateNfoContent(videoInfo, conjunto, year, round = null) {
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

  const escapeXml = (unsafe) => {
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
          return "";
        default:
          return c;
      }
    });
  };

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
 * Download a video using yt-dlp (Reverted to execSync)
 * @param {string} videoUrl - URL of the video to download
 * @param {string} videoIdParam - Video ID passed as parameter
 * @param {string} outputDir - Directory to save the video
 * @param {string} baseFilename - Base filename for the video and NFO files
 * @param {Object} nfoData - Data for NFO file generation { videoInfo, conjunto, year, round }
 * @param {string} downloadedArchivePath - Path to the yt-dlp download archive file
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} True if download was successful or NFO generated
 */
export async function downloadVideo( // Make async for NFO write
  videoUrl,
  videoIdParam,
  outputDir,
  baseFilename,
  nfoData,
  downloadedArchivePath,
  logger
) {
  // Validation Logic (Keep from previous version)
  if (!nfoData || !nfoData.videoInfo || !nfoData.conjunto || !nfoData.year) {
    logger.error(
      `[downloadVideo] Missing essential nfoData components for video URL ${videoUrl}`,
      {
        /*...*/
      }
    );
    // Since execSync is sync, we can't easily reject a promise here. Throw error instead.
    throw new Error(
      `Missing essential NFO data components for video URL ${videoUrl}`
    );
  }
  const videoIdFromInfo = nfoData.videoInfo.id;
  if (!videoIdFromInfo) {
    logger.error(
      `[downloadVideo] videoInfo within nfoData is missing the 'id' property for video URL ${videoUrl}`,
      {
        /*...*/
      }
    );
    throw new Error(`videoInfo is missing 'id' for video URL ${videoUrl}`);
  }
  let videoId = videoIdFromInfo;
  if (videoIdParam !== videoId) {
    logger.warn(
      `[downloadVideo] Initial videoId parameter ('${videoIdParam}') differs from metadata ID ('${videoId}'). Using metadata ID.`
    );
  }

  logger.info(
    `Starting download process for video ${videoId}: ${
      nfoData.videoInfo.title || "Unknown Title"
    }`
  );
  logger.info(`(yt-dlp output follows directly below)`);

  const outputTemplate = path.join(outputDir, baseFilename + ".%(ext)s");

  // Construct the command string, ensuring proper quoting
  // Use single quotes for the main command parts and double quotes inside if needed by shell
  // Or rely on execSync handling arguments if passed as an array (safer)
  // Let's build the command string carefully, similar to the old code:
  const commandParts = [
    "yt-dlp",
    `"${videoUrl}"`, // Quote URL
    "--format",
    // Quote format string
    `"bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best"`,
    "--output",
    `"${outputTemplate}"`, // Quote output template
    "--write-info-json",
    "--no-write-playlist-metafiles",
    // Ensure --no-progress is NOT included
    "--verbose", // Keep verbose for direct output
    "--download-archive",
    `"${downloadedArchivePath}"`, // Quote archive path
    "--retries",
    "3",
    "--fragment-retries",
    "3",
  ];
  const command = commandParts.join(" ");

  logger.debug(`Executing yt-dlp command: ${command}`);

  try {
    // Execute synchronously, inheriting stdio
    execSync(command, { stdio: "inherit", encoding: "utf-8" });
    // If execSync doesn't throw, yt-dlp exited with code 0 (success or already archived)
    console.log(""); // Add newline after yt-dlp finishes
    logger.info(
      `yt-dlp process for ${videoId} finished successfully (exit code 0).`
    );

    // Generate and save NFO file (this part needs to remain async)
    try {
      const nfoPath = path.join(outputDir, baseFilename + ".nfo");
      if (!(await fs.pathExists(nfoPath))) {
        const nfoContent = generateNfoContent(
          nfoData.videoInfo,
          nfoData.conjunto,
          nfoData.year,
          nfoData.round
        );
        await fs.writeFile(nfoPath, nfoContent);
        logger.info(`Created NFO file for ${videoId} at ${nfoPath}`);
      } else {
        logger.debug(`NFO file already exists for ${videoId} at ${nfoPath}`);
      }
      return true; // Indicate overall success
    } catch (nfoError) {
      logger.error(
        `Failed to write NFO file for ${videoId} after successful download`,
        {
          nfoPath: path.join(outputDir, baseFilename + ".nfo"),
          error: nfoError.message,
          stack: nfoError.stack,
        }
      );
      return true; // Still return true as download was ok, NFO is secondary
    }
  } catch (error) {
    // execSync throws an error if the command fails (non-zero exit code)
    console.log(""); // Add newline after yt-dlp finishes (even on error)
    logger.error(`yt-dlp process for ${videoId} failed.`);
    // The error object from execSync often contains stderr/stdout if captured,
    // but with stdio:inherit, they are printed directly. We log the error message.
    logger.error("yt-dlp Error Message:", { message: error.message });
    logger.error(
      "Check the direct terminal output above for detailed yt-dlp errors."
    );
    // We need to indicate failure. Since this function is async now for NFO, return false.
    return false;
  }
}
