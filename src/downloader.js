import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import dayjs from "dayjs";

/**
 * Check if a video should be downloaded based on its metadata
 * @param {Object} videoInfo - Video metadata
 * @returns {Object} Decision object with download and reason properties
 */
export function shouldDownload(videoInfo) {
  // Skip videos shorter than 2 minutes
  if (videoInfo.duration < 120) {
    return {
      download: false,
      reason: `Video duration (${videoInfo.duration}s) is less than 2 minutes`,
    };
  }

  // Skip videos longer than 30 minutes (likely live streams or compilations)
  if (videoInfo.duration > 1800) {
    return {
      download: false,
      reason: `Video duration (${videoInfo.duration}s) is more than 30 minutes`,
    };
  }

  // Skip videos with certain keywords in the title
  const skipKeywords = ["prueba", "ensayo", "desfile", "llamadas"];
  const normalizedTitle = videoInfo.title.toLowerCase();
  for (const keyword of skipKeywords) {
    if (normalizedTitle.includes(keyword)) {
      return {
        download: false,
        reason: `Title contains skip keyword: ${keyword}`,
      };
    }
  }

  return { download: true };
}

/**
 * Generate NFO file content for a video
 * @param {Object} videoInfo - Video metadata
 * @param {Object} conjunto - Conjunto information
 * @param {string} year - Performance year
 * @returns {string} NFO file content in XML format
 */
export function generateNfoContent(videoInfo, conjunto, year) {
  const title =
    videoInfo.isAlternativeFormat && videoInfo.round
      ? `${conjunto.name} ${year} - ${videoInfo.round}`
      : `${conjunto.name} ${year}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${title}</title>
    <originaltitle>${videoInfo.title}</originaltitle>
    <sorttitle>${conjunto.name} ${year}</sorttitle>
    <year>${year}</year>
    <genre>Carnival</genre>
    <genre>${conjunto.category}</genre>
    ${videoInfo.round ? `<genre>${videoInfo.round}</genre>` : ""}
    <plot>${videoInfo.description || ""}</plot>
    <source>YouTube</source>
    <dateadded>${dayjs().format()}</dateadded>
</movie>`;
}

/**
 * Download a video using yt-dlp
 * @param {string} videoUrl - URL of the video to download
 * @param {string} videoId - Video ID
 * @param {string} outputDir - Directory to save the video
 * @param {string} baseFilename - Base filename for the video and NFO files
 * @param {Object} nfoData - Data for NFO file generation
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} True if download was successful
 */
export function downloadVideo(
  videoUrl,
  videoId,
  outputDir,
  baseFilename,
  nfoData,
  logger
) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting download for video ${videoId}`);

    const outputTemplate = path.join(outputDir, baseFilename + ".%(ext)s");
    const args = [
      videoUrl,
      "--output",
      outputTemplate,
      "--write-info-json",
      "--no-write-playlist-metafiles",
      "--no-progress",
      "--format",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    ];

    const ytDlp = spawn("yt-dlp", args);
    let stdoutData = "";
    let stderrData = "";

    ytDlp.stdout.on("data", (data) => {
      stdoutData += data.toString();
      logger.debug(`yt-dlp stdout: ${data.toString().trim()}`);
    });

    ytDlp.stderr.on("data", (data) => {
      stderrData += data.toString();
      logger.debug(`yt-dlp stderr: ${data.toString().trim()}`);
    });

    ytDlp.on("error", (error) => {
      logger.error("Failed to spawn yt-dlp process", { error: error.message });
      reject(error);
    });

    ytDlp.on("close", async (code) => {
      if (code === 0) {
        try {
          // Generate and write NFO file
          const nfoPath = path.join(outputDir, baseFilename + ".nfo");
          const nfoContent = generateNfoContent(
            nfoData.videoInfo,
            nfoData.conjunto,
            nfoData.year
          );
          await fs.writeFile(nfoPath, nfoContent);
          logger.info(
            `Successfully downloaded video ${videoId} and created NFO file`
          );
          resolve(true);
        } catch (error) {
          logger.error("Failed to write NFO file", {
            videoId,
            error: error.message,
          });
          reject(error);
        }
      } else {
        logger.error("yt-dlp process failed", {
          videoId,
          code,
          stdout: stdoutData,
          stderr: stderrData,
        });
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });
  });
}
