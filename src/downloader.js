import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import dayjs from "dayjs";

/**
 * Check if a video should be downloaded based on its metadata
 * @param {Object} videoInfo - Full video metadata obtained from yt-dlp dump-json
 * @param {Object} parsedInfo - Result from parseVideoTitle containing year, conjunto etc.
 * @param {Object} logger - Logger instance
 * @returns {Object} Decision object with download: boolean and reason: string properties
 */
export function shouldDownload(videoInfo, parsedInfo, logger) {
  const { title, duration } = videoInfo;
  logger.info(
    `Checking download criteria for video: ${title} (ID: ${videoInfo.id})`
  );
  logger.info(`Video duration: ${duration} seconds`);

  const durationMinutes = parseInt(duration) / 60;
  const normalizedTitle = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Competition round format should always download if parsed correctly
  if (parsedInfo.isAlternativeFormat && parsedInfo.round) {
    logger.info(
      `Video is a competition round ('${parsedInfo.round}'), will download.`
    );
    return { download: true, reason: "Competition round format" };
  }

  // Original logic checks:
  if (durationMinutes < 30) {
    // Allow short 'fragmento' videos before 2005
    const year = parsedInfo.year ? parseInt(parsedInfo.year) : null;
    if (normalizedTitle.includes("fragmento") && year && year < 2005) {
      logger.info(
        "Video is a 'fragmento' before 2005, will download despite duration."
      );
      return { download: true, reason: "Fragmento before 2005" };
    }
    logger.info(
      `Video duration (${durationMinutes.toFixed(
        1
      )} min) is less than 30 minutes and doesn't meet exceptions, skipping.`
    );
    return {
      download: false,
      reason: `Video duration (${durationMinutes.toFixed(1)} min) < 30 min`,
    };
  }

  const hasActuacionCompleta = normalizedTitle.includes("actuacion completa");
  const hasResumen = normalizedTitle.includes("resumen");

  logger.info(
    `Title conditions: actuacion completa: ${hasActuacionCompleta}, resumen: ${hasResumen}`
  );

  if (hasResumen) {
    logger.info("Video title contains 'resumen', skipping.");
    return { download: false, reason: "Title contains 'resumen'" };
  }

  // If it's long enough (>30min) and not a 'resumen', download it.
  // The 'actuacion completa' check becomes less critical if duration is the primary filter > 30min.
  // Let's keep it simple: if > 30 min and not 'resumen', download.
  logger.info(
    "Video meets duration criteria (>30 min) and is not a 'resumen', will download."
  );
  return { download: true, reason: "Duration > 30 min and not a resumen" };
}

/**
 * Generate NFO file content for a video
 * @param {Object} videoInfo - Video metadata
 * @param {Object} conjunto - Conjunto information
 * @param {string} year - Performance year
 * @param {string | null} round - Performance round (optional)
 * @returns {string} NFO file content in XML format
 */
export function generateNfoContent(videoInfo, conjunto, year, round = null) {
  const title = round
    ? `${conjunto.name} ${year} - ${round}`
    : `${conjunto.name} ${year}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${title}</title>
    <originaltitle>${videoInfo.title}</originaltitle>
    <sorttitle>${conjunto.name} ${year}${round ? ` ${round}` : ""}</sorttitle>
    <year>${year}</year>
    <genre>Carnival</genre>
    <genre>${conjunto.category}</genre>
    ${round ? `<genre>${round}</genre>` : ""}
    <plot>${videoInfo.description || ""}</plot>
    <source>YouTube</source>
    <id>${videoInfo.id}</id>
    <uniqueid type="YouTube" default="true">${videoInfo.id}</uniqueid>
    <dateadded>${dayjs().format()}</dateadded>
</movie>`;
}

/**
 * Download a video using yt-dlp
 * @param {string} videoUrl - URL of the video to download
 * @param {string} videoId - Video ID
 * @param {string} outputDir - Directory to save the video
 * @param {string} baseFilename - Base filename for the video and NFO files
 * @param {Object} nfoData - Data for NFO file generation { videoInfo, conjunto, year, round }
 * @param {string} downloadedArchivePath - Path to the yt-dlp download archive file
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} True if download was successful
 */
export function downloadVideo(
  videoUrl,
  videoId,
  outputDir,
  baseFilename,
  nfoData,
  downloadedArchivePath,
  logger
) {
  return new Promise((resolve, reject) => {
    logger.info(
      `Starting download for video ${videoId}: ${nfoData.videoInfo.title}`
    );

    const outputTemplate = path.join(outputDir, baseFilename + ".%(ext)s");
    const args = [
      videoUrl,
      "--output",
      outputTemplate,
      "--write-info-json", // Write metadata to a .info.json file
      "--no-write-playlist-metafiles",
      "--no-progress",
      "--format",
      "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best", // Prefer mp4 up to 1080p
      "--download-archive",
      downloadedArchivePath, // Use yt-dlp's archive feature
      "--retries",
      "3", // Retry downloads
      "--fragment-retries",
      "3", // Retry fragments
      "--abort-on-error", // Stop if a critical error occurs
    ];

    logger.debug(`Executing yt-dlp with args: ${args.join(" ")}`);

    const ytDlp = spawn("yt-dlp", args);
    let stdoutData = "";
    let stderrData = "";

    ytDlp.stdout.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        stdoutData += line + "\n";
        logger.debug(`yt-dlp stdout: ${line}`);
      }
    });

    ytDlp.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        stderrData += line + "\n";
        // Don't log every stderr line as error, only on failure
        logger.debug(`yt-dlp stderr: ${line}`);
      }
    });

    ytDlp.on("error", (error) => {
      logger.error(`Failed to spawn yt-dlp process for ${videoId}`, {
        error: error.message,
      });
      reject(error);
    });

    ytDlp.on("close", async (code) => {
      // code 101 can indicate video is already in archive
      if (code === 0 || code === 101) {
        if (stdoutData.includes("has already been recorded in the archive")) {
          logger.info(
            `Video ${videoId} already in download archive, skipping download but ensuring NFO exists.`
          );
        } else if (code === 0) {
          logger.info(
            `yt-dlp downloaded video ${videoId} successfully (exit code 0).`
          );
        } else {
          logger.info(
            `yt-dlp finished for ${videoId} (exit code ${code}), likely already downloaded.`
          );
        }

        try {
          // Generate and write NFO file regardless of whether download happened,
          // as long as yt-dlp didn't report a fatal error (code != 0 and != 101)
          const nfoPath = path.join(outputDir, baseFilename + ".nfo");
          // Check if NFO already exists to avoid unnecessary writes
          if (!(await fs.pathExists(nfoPath))) {
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
          resolve(true); // Consider it success if yt-dlp didn't error fatally
        } catch (error) {
          logger.error(`Failed to write NFO file for ${videoId}`, {
            error: error.message,
          });
          // Don't reject the whole process, just log the NFO error
          resolve(true); // Still resolve true as download might have worked
        }
      } else {
        logger.error(`yt-dlp process for ${videoId} failed`, {
          code,
          stdout: stdoutData,
          stderr: stderrData,
        });
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });
  });
}
