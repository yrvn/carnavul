import fs from "fs-extra";
import path from "path";
import logger from "./logger.js";

export const trackingDirName = ".tracking";

/**
 * Initialize tracking directory and files
 * @param {string} baseDir - Base directory for downloads
 * @returns {Promise<Object>} Object containing paths to all tracking files
 */
export async function initTracking(baseDir) {
  logger.info("Initializing tracking directory and files...");
  const trackingDir = path.join(baseDir, trackingDirName);
  await fs.ensureDir(trackingDir);
  logger.info(`Created tracking directory at ${trackingDir}`);

  const trackingFiles = {
    downloadedPath: path.join(trackingDir, "downloaded.txt"),
    checkLaterPath: path.join(trackingDir, "check_later.json"),
    ignoredPath: path.join(trackingDir, "ignored.json"),
    incompletePath: path.join(trackingDir, "incomplete.json"),
    failedPath: path.join(trackingDir, "failed.json"),
  };

  // Initialize each tracking file
  for (const [key, filePath] of Object.entries(trackingFiles)) {
    try {
      if (key === "downloadedPath") {
        await fs.ensureFile(filePath);
      } else {
        await fs.ensureFile(filePath);
        const exists = await fs.pathExists(filePath);
        if (!exists || (await fs.stat(filePath)).size === 0) {
          await fs.writeJson(filePath, [], { spaces: 2 });
        }
      }
      logger.info(`Initialized ${key} at ${filePath}`);
    } catch (error) {
      logger.error(`Failed to initialize ${key}`, { error: error.message });
      throw error;
    }
  }

  return trackingFiles;
}

/**
 * Get a Set of downloaded video IDs
 * @param {string} downloadedPath - Path to downloaded.txt
 * @returns {Promise<Set<string>>} Set of downloaded video IDs
 */
export async function getDownloadedSet(downloadedPath) {
  try {
    const downloadedIds = new Set();
    if (await fs.pathExists(downloadedPath)) {
      const content = await fs.readFile(downloadedPath, "utf8");
      content.split("\n").forEach((line) => {
        const match = line.match(/youtube\s+([^\s]+)/);
        if (match) {
          downloadedIds.add(match[1]);
        }
      });
    }
    logger.debug(`Loaded ${downloadedIds.size} downloaded video IDs`);
    return downloadedIds;
  } catch (error) {
    logger.error("Failed to read downloaded IDs", { error: error.message });
    throw error;
  }
}

/**
 * Add a video ID to the downloaded list
 * @param {string} downloadedPath - Path to downloaded.txt
 * @param {string} videoId - Video ID to add
 */
export async function addToDownloaded(downloadedPath, videoId) {
  try {
    await fs.appendFile(downloadedPath, `youtube ${videoId}\n`);
    logger.debug(`Added ${videoId} to downloaded list`);
  } catch (error) {
    logger.error("Failed to add to downloaded list", {
      videoId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Read a JSON tracking file
 * @param {string} filePath - Path to the JSON file
 * @returns {Promise<Array>} Array of tracking entries
 */
export async function readTrackingJson(filePath) {
  try {
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      logger.warn(
        `Tracking file ${filePath} does not exist, returning empty array`
      );
      return [];
    }
    const data = await fs.readJson(filePath);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    logger.error(`Failed to read tracking file ${filePath}`, {
      error: error.message,
    });
    return [];
  }
}

/**
 * Write data to a JSON tracking file
 * @param {string} filePath - Path to the JSON file
 * @param {Array} data - Data to write
 */
export async function writeTrackingJson(filePath, data) {
  try {
    await fs.writeJson(filePath, data, { spaces: 2 });
    logger.debug(`Updated tracking file ${filePath}`);
  } catch (error) {
    logger.error(`Failed to write tracking file ${filePath}`, {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Add an entry to a tracking file
 * @param {string} filePath - Path to the tracking file
 * @param {Object} entry - Entry to add
 */
export async function addTrackingEntry(filePath, entry) {
  try {
    const entries = await readTrackingJson(filePath);
    entries.push(entry);
    await writeTrackingJson(filePath, entries);
    logger.debug(`Added entry to ${filePath}`, { entry });
  } catch (error) {
    logger.error(`Failed to add tracking entry to ${filePath}`, {
      entry,
      error: error.message,
    });
    throw error;
  }
}
