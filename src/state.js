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
    downloadedPath: path.join(trackingDir, "downloaded.txt"), // Used by yt-dlp --download-archive
    checkLaterPath: path.join(trackingDir, "check_later.json"),
    ignoredPath: path.join(trackingDir, "ignored.json"),
    incompletePath: path.join(trackingDir, "incomplete.json"), // Consider removing if redundant
    failedPath: path.join(trackingDir, "failed.json"),
  };

  // Initialize each tracking file
  for (const [key, filePath] of Object.entries(trackingFiles)) {
    try {
      await fs.ensureFile(filePath);
      if (filePath.endsWith(".json")) {
        try {
          const stat = await fs.stat(filePath);
          if (stat.size === 0) {
            await fs.writeJson(filePath, [], { spaces: 2 });
          } else {
            await fs.readJson(filePath); // Validate existing JSON
          }
        } catch (readError) {
          logger.warn(
            `Tracking file ${filePath} was invalid or corrupted. Initializing with empty array.`,
            { error: readError.message }
          );
          await fs.writeJson(filePath, [], { spaces: 2 });
        }
      }
      logger.info(`Ensured tracking file exists: ${key} at ${filePath}`);
    } catch (error) {
      logger.error(`Failed to initialize tracking file ${key}`, {
        filePath,
        error: error.message,
      });
      throw error;
    }
  }

  return trackingFiles;
}

/**
 * Get a Set of downloaded video IDs from the yt-dlp archive file.
 * @param {string} downloadedPath - Path to downloaded.txt (yt-dlp archive)
 * @returns {Promise<Set<string>>} Set of downloaded video IDs
 */
export async function getDownloadedSet(downloadedPath) {
  const downloadedIds = new Set();
  try {
    if (await fs.pathExists(downloadedPath)) {
      const content = await fs.readFile(downloadedPath, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const potentialId = parts[parts.length - 1];
          if (
            potentialId &&
            potentialId.length === 11 &&
            /^[a-zA-Z0-9_-]+$/.test(potentialId)
          ) {
            downloadedIds.add(potentialId);
          } else if (potentialId) {
            downloadedIds.add(potentialId);
            logger.debug(
              `Added potential non-YouTube ID from archive: ${potentialId}`
            );
          }
        }
      }
    }
  } catch (error) {
    logger.error("Failed to read or parse download archive file", {
      downloadedPath,
      error: error.message,
    });
  }
  logger.info(
    `Loaded ${downloadedIds.size} video IDs from download archive: ${downloadedPath}`
  );
  return downloadedIds;
}

/**
 * Read a JSON tracking file safely.
 * @param {string} filePath - Path to the JSON file
 * @returns {Promise<Array>} Array of tracking entries, or empty array on error/non-existence.
 */
export async function readTrackingJson(filePath) {
  try {
    if (!(await fs.pathExists(filePath))) {
      logger.warn(
        `Tracking file ${filePath} does not exist, returning empty array.`
      );
      return [];
    }
    const data = await fs.readJson(filePath, { throws: false });
    if (data === null || !Array.isArray(data)) {
      logger.warn(
        `Tracking file ${filePath} contained invalid data or was not an array. Returning empty array.`
      );
      return [];
    }
    return data;
  } catch (error) {
    logger.error(`Failed to read tracking file ${filePath}`, {
      error: error.message,
    });
    return [];
  }
}

/**
 * Write data to a JSON tracking file safely.
 * @param {string} filePath - Path to the JSON file
 * @param {Array} data - Data to write (should be an array)
 */
export async function writeTrackingJson(filePath, data) {
  try {
    if (!Array.isArray(data)) {
      logger.error(
        `Attempted to write non-array data to JSON tracking file ${filePath}. Aborting write.`
      );
      return;
    }
    await fs.writeJson(filePath, data, { spaces: 2 });
    logger.debug(
      `Updated tracking file ${filePath} with ${data.length} entries.`
    );
  } catch (error) {
    logger.error(`Failed to write tracking file ${filePath}`, {
      error: error.message,
    });
  }
}

/**
 * Add a single entry to a JSON tracking file.
 * Reads the existing file, pushes the new entry, and writes back.
 * Consider adding logic to prevent duplicates or update existing entries if needed.
 * @param {string} filePath - Path to the tracking file
 * @param {Object} entry - Entry object to add
 */
export async function addTrackingEntry(filePath, entry) {
  try {
    const entries = await readTrackingJson(filePath);
    // Optional: Check for duplicates based on ID before pushing
    // const existingIndex = entries.findIndex(e => e.id === entry.id);
    // if (existingIndex !== -1) {
    //   logger.debug(`Updating existing entry for ID ${entry.id} in ${filePath}`);
    //   entries[existingIndex] = entry; // Update existing
    // } else {
    //   entries.push(entry); // Add new
    // }
    entries.push(entry); // Simple push for now
    await writeTrackingJson(filePath, entries);
    logger.debug(`Added entry to ${filePath}`, {
      title: entry.title || entry.id,
    });
  } catch (error) {
    logger.error(`Failed to add tracking entry to ${filePath}`, {
      entry: entry.id || entry.title,
      error: error.message,
    });
  }
}

/**
 * Get a Set of video IDs from a JSON tracking file.
 * @param {string} filePath - Path to the JSON tracking file
 * @param {Object} logger - Logger instance
 * @returns {Promise<Set<string>>} Set of video IDs found in the file
 */
export async function getTrackingIds(filePath, logger) {
  const ids = new Set();
  try {
    const entries = await readTrackingJson(filePath); // Use the safe reader
    for (const entry of entries) {
      if (entry && entry.id) {
        ids.add(entry.id);
      }
    }
  } catch (error) {
    // readTrackingJson should handle most read errors, but catch any unexpected ones
    logger.error(`Failed to get IDs from tracking file ${filePath}`, {
      error: error.message,
    });
    // Re-throw or return empty set? Throwing makes the caller aware.
    throw error;
  }
  logger.debug(`Loaded ${ids.size} IDs from ${filePath}`);
  return ids;
}

/**
 * Remove an entry from a JSON tracking file by its video ID.
 * @param {string} filePath - Path to the tracking file
 * @param {string} videoId - The ID of the video entry to remove
 * @param {Object} logger - Logger instance
 */
export async function removeTrackingEntryById(filePath, videoId, logger) {
  if (!videoId) {
    logger.warn(
      `[removeTrackingEntryById] Attempted to remove entry with null/empty ID from ${filePath}`
    );
    return;
  }
  try {
    const entries = await readTrackingJson(filePath);
    const initialLength = entries.length;
    const filteredEntries = entries.filter(
      (entry) => !(entry && entry.id === videoId)
    ); // Ensure entry and entry.id exist
    const removedCount = initialLength - filteredEntries.length;

    if (removedCount > 0) {
      await writeTrackingJson(filePath, filteredEntries);
      logger.info(
        `Removed ${removedCount} entry/entries with ID ${videoId} from ${filePath}`
      );
    } else {
      logger.debug(
        `[removeTrackingEntryById] No entry found with ID ${videoId} in ${filePath} to remove.`
      );
    }
  } catch (error) {
    // Errors during read/write are logged within those functions.
    logger.error(
      `Failed to remove tracking entry ID ${videoId} from ${filePath}`,
      {
        error: error.message,
      }
    );
    // Consider re-throwing if removal failure is critical
  }
}
