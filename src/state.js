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
    // Note: incompletePath seems redundant if check_later handles items without 'download: true'
    // Keeping it for now, but consider merging its purpose into check_later or removing.
    incompletePath: path.join(trackingDir, "incomplete.json"),
    failedPath: path.join(trackingDir, "failed.json"),
  };

  // Initialize each tracking file
  for (const [key, filePath] of Object.entries(trackingFiles)) {
    try {
      // Ensure the file exists. For JSON files, initialize with empty array if new/empty.
      await fs.ensureFile(filePath);
      if (filePath.endsWith(".json")) {
        try {
          // Check if file is empty or invalid JSON, then initialize
          const stat = await fs.stat(filePath);
          if (stat.size === 0) {
            await fs.writeJson(filePath, [], { spaces: 2 });
          } else {
            // Try reading to ensure it's valid JSON
            await fs.readJson(filePath);
          }
        } catch (readError) {
          // If reading fails (e.g., invalid JSON), overwrite with empty array
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
      // yt-dlp archive format is typically "<extractor> <id>" per line
      const lines = content.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/); // Split by whitespace
        if (parts.length >= 2) {
          // Assume the last part is the ID, handles cases like "youtube YOUTUBE_ID"
          // Or potentially other extractors. Be somewhat robust.
          const potentialId = parts[parts.length - 1];
          // Basic check for YouTube ID format (11 chars, base64-like)
          // This isn't foolproof but helps filter obvious non-IDs.
          if (
            potentialId &&
            potentialId.length === 11 &&
            /^[a-zA-Z0-9_-]+$/.test(potentialId)
          ) {
            downloadedIds.add(potentialId);
          } else if (potentialId) {
            // Accept other IDs too, maybe from different extractors
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
    // Proceed with an empty set, but log the error.
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
    // ensureFile was called in initTracking, but check existence again just in case.
    if (!(await fs.pathExists(filePath))) {
      logger.warn(
        `Tracking file ${filePath} does not exist, returning empty array.`
      );
      return [];
    }
    // Attempt to read, default to empty array on error
    const data = await fs.readJson(filePath, { throws: false });
    if (data === null || !Array.isArray(data)) {
      logger.warn(
        `Tracking file ${filePath} contained invalid data or was not an array. Returning empty array.`
      );
      // Optionally, attempt to repair the file here by writing `[]`
      // await fs.writeJson(filePath, [], { spaces: 2 });
      return [];
    }
    return data;
  } catch (error) {
    // This catch block might be redundant due to throws: false, but kept for safety.
    logger.error(`Failed to read tracking file ${filePath}`, {
      error: error.message,
    });
    return []; // Return empty array on unexpected errors
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
      return; // Prevent writing invalid data
    }
    await fs.writeJson(filePath, data, { spaces: 2 });
    logger.debug(
      `Updated tracking file ${filePath} with ${data.length} entries.`
    );
  } catch (error) {
    logger.error(`Failed to write tracking file ${filePath}`, {
      error: error.message,
    });
    // Re-throw? Or just log? Depends on desired robustness. Logging for now.
  }
}

/**
 * Add a single entry to a JSON tracking file.
 * Reads the existing file, pushes the new entry, and writes back.
 * @param {string} filePath - Path to the tracking file
 * @param {Object} entry - Entry object to add
 */
export async function addTrackingEntry(filePath, entry) {
  try {
    const entries = await readTrackingJson(filePath); // Safely reads existing data
    entries.push(entry);
    await writeTrackingJson(filePath, entries); // Safely writes updated data
    logger.debug(`Added entry to ${filePath}`, {
      title: entry.title || entry.id,
    });
  } catch (error) {
    // Errors during read/write are logged within those functions.
    // Log an additional context-specific error here.
    logger.error(`Failed to add tracking entry to ${filePath}`, {
      entry: entry.id || entry.title, // Log identifying info
      error: error.message,
    });
  }
}
